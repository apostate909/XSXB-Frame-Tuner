const fs = require("node:fs");
const zlib = require("node:zlib");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function collisionOffsetY(height) {
  return -Math.max(1, Number(height || 1)) / 2;
}

function fullBounds(width, height) {
  return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) };
}

function trimmedSpan(counts, fallbackMin, fallbackMax, trimRatio = 0.003) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { min: fallbackMin, max: fallbackMax };
  const trim = Math.max(0, Math.floor(total * trimRatio));
  let min = fallbackMin;
  let max = fallbackMax;
  let acc = 0;
  for (let index = fallbackMin; index <= fallbackMax; index += 1) {
    acc += counts[index] || 0;
    if (acc > trim) {
      min = index;
      break;
    }
  }
  acc = 0;
  for (let index = fallbackMax; index >= fallbackMin; index -= 1) {
    acc += counts[index] || 0;
    if (acc > trim) {
      max = index;
      break;
    }
  }
  return min <= max ? { min, max } : { min: fallbackMin, max: fallbackMax };
}

function denseColumnSpan(columns, minX, maxX) {
  let maxCount = 0;
  const smoothed = columns.map((value, index) => {
    let sum = 0;
    let count = 0;
    for (let cursor = Math.max(minX, index - 2); cursor <= Math.min(maxX, index + 2); cursor += 1) {
      sum += columns[cursor] || 0;
      count += 1;
    }
    const average = count ? sum / count : value;
    maxCount = Math.max(maxCount, average);
    return average;
  });
  const threshold = Math.max(4, maxCount * 0.22);
  let best = null;
  let start = -1;
  let score = 0;
  let gap = 0;
  const closeSegment = (end) => {
    if (start < 0) return;
    const segment = { min: start, max: end, score };
    if (!best || segment.score > best.score) best = segment;
    start = -1;
    score = 0;
    gap = 0;
  };
  for (let x = minX; x <= maxX; x += 1) {
    const value = smoothed[x] || 0;
    if (value >= threshold) {
      if (start < 0) start = x;
      score += value;
      gap = 0;
    } else if (start >= 0 && gap < 6) {
      score += value * 0.25;
      gap += 1;
    } else {
      closeSegment(x - gap - 1);
    }
  }
  closeSegment(maxX - gap);
  if (!best) return { min: minX, max: maxX };
  return { min: Math.max(minX, best.min), max: Math.min(maxX, best.max) };
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function parsePng(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 33 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  let offset = 8;
  let info = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    if (type === "IHDR") {
      info = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        bitDepth: buffer[start + 8],
        colorType: buffer[start + 9],
        interlace: buffer[start + 12],
      };
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (!info) return null;
  return { ...info, idat: Buffer.concat(idat) };
}

function channelsForColorType(colorType) {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

function unfilter(raw, width, height, rowBytes, bytesPerPixel) {
  const result = Buffer.alloc(rowBytes * height);
  let inputOffset = 0;
  let outputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[inputOffset];
    inputOffset += 1;
    for (let x = 0; x < rowBytes; x += 1) {
      const value = raw[inputOffset] || 0;
      inputOffset += 1;
      const left = x >= bytesPerPixel ? result[outputOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? result[outputOffset - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? result[outputOffset - rowBytes + x - bytesPerPixel] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = Math.floor((left + up) / 2);
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      result[outputOffset + x] = (value + predicted) & 0xff;
    }
    outputOffset += rowBytes;
  }
  return result;
}

function channel8(decoded, offset, sampleBytes) {
  return sampleBytes === 1 ? decoded[offset] : Math.round(decoded.readUInt16BE(offset) / 257);
}

function isChromaGreen(r, g, b) {
  const other = Math.max(r, b);
  return g >= 28 && g - other >= 12 && g >= other * 1.12;
}

function isWeaponAccent(r, g, b) {
  return r >= 70 && r - g >= 32 && r - b >= 18 && r >= Math.max(g, 1) * 1.3;
}

function largestMaskBounds(mask, width, height) {
  if (!mask) return null;
  const queue = new Int32Array(width * height);
  let best = null;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1) continue;
    let head = 0;
    let tail = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    queue[tail++] = start;
    mask[start] = 2;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (mask[next] !== 1) continue;
          mask[next] = 2;
          queue[tail++] = next;
        }
      }
    }
    if (tail < 12 || (best && tail <= best.pixels)) continue;
    best = {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      pixels: tail,
    };
  }
  return best;
}

function hasGreenScreenBorder(decoded, png, rowBytes, pixelBytes, sampleBytes) {
  if (png.colorType !== 2 && png.colorType !== 6) return false;
  const alphaOffset = png.colorType === 6 ? 3 * sampleBytes : -1;
  const samples = [];
  const steps = [0, 0.25, 0.5, 0.75, 1];
  for (const step of steps) {
    const x = Math.round((png.width - 1) * step);
    const y = Math.round((png.height - 1) * step);
    samples.push([x, 0], [x, png.height - 1], [0, y], [png.width - 1, y]);
  }
  let visible = 0;
  let green = 0;
  for (const [x, y] of samples) {
    const offset = y * rowBytes + x * pixelBytes;
    const alpha = alphaOffset >= 0 ? channel8(decoded, offset + alphaOffset, sampleBytes) : 255;
    if (alpha <= 24) continue;
    visible += 1;
    if (isChromaGreen(
      channel8(decoded, offset, sampleBytes),
      channel8(decoded, offset + sampleBytes, sampleBytes),
      channel8(decoded, offset + sampleBytes * 2, sampleBytes),
    )) green += 1;
  }
  return visible >= 8 && green / visible >= 0.75;
}

function opaqueBoundsForPng(filePath) {
  const png = parsePng(filePath);
  if (!png?.width || !png?.height) return null;
  const fallback = fullBounds(png.width, png.height);
  if (!png.idat?.length || png.interlace !== 0) return { ...fallback, canvasWidth: png.width, canvasHeight: png.height };
  const channels = channelsForColorType(png.colorType);
  const sampleBytes = png.bitDepth === 16 ? 2 : png.bitDepth === 8 ? 1 : 0;
  if (!channels || !sampleBytes) return { ...fallback, canvasWidth: png.width, canvasHeight: png.height };
  const pixelBytes = channels * sampleBytes;
  const rowBytes = png.width * pixelBytes;
  let decoded;
  try {
    decoded = unfilter(zlib.inflateSync(png.idat), png.width, png.height, rowBytes, Math.max(1, pixelBytes));
  } catch {
    return { ...fallback, canvasWidth: png.width, canvasHeight: png.height };
  }
  if (png.colorType !== 2 && png.colorType !== 4 && png.colorType !== 6) {
    return { ...fallback, canvasWidth: png.width, canvasHeight: png.height };
  }
  const alphaOffset = png.colorType === 6 ? 3 * sampleBytes : png.colorType === 4 ? sampleBytes : -1;
  const greenScreen = hasGreenScreenBorder(decoded, png, rowBytes, pixelBytes, sampleBytes);
  const columns = Array(png.width).fill(0);
  const rows = Array(png.height).fill(0);
  const weaponAccentMask = png.colorType === 2 || png.colorType === 6
    ? new Uint8Array(png.width * png.height)
    : null;
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    const rowOffset = y * rowBytes;
    for (let x = 0; x < png.width; x += 1) {
      const offset = rowOffset + x * pixelBytes;
      const alpha = alphaOffset >= 0 ? channel8(decoded, offset + alphaOffset, sampleBytes) : 255;
      if (alpha <= 24) continue;
      if (greenScreen && isChromaGreen(
        channel8(decoded, offset, sampleBytes),
        channel8(decoded, offset + sampleBytes, sampleBytes),
        channel8(decoded, offset + sampleBytes * 2, sampleBytes),
      )) continue;
      if (weaponAccentMask && isWeaponAccent(
        channel8(decoded, offset, sampleBytes),
        channel8(decoded, offset + sampleBytes, sampleBytes),
        channel8(decoded, offset + sampleBytes * 2, sampleBytes),
      )) weaponAccentMask[y * png.width + x] = 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      columns[x] += 1;
      rows[y] += 1;
    }
  }
  if (maxX < minX || maxY < minY) return { ...fallback, canvasWidth: png.width, canvasHeight: png.height };
  const xSpan = trimmedSpan(columns, minX, maxX);
  const ySpan = trimmedSpan(rows, minY, maxY);
  const bodyXSpan = denseColumnSpan(columns, xSpan.min, xSpan.max);
  let bodyMinX = png.width;
  let bodyMinY = png.height;
  let bodyMaxX = -1;
  let bodyMaxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    const rowOffset = y * rowBytes;
    for (let x = bodyXSpan.min; x <= bodyXSpan.max; x += 1) {
      const offset = rowOffset + x * pixelBytes;
      const alpha = alphaOffset >= 0 ? channel8(decoded, offset + alphaOffset, sampleBytes) : 255;
      if (alpha <= 24) continue;
      if (greenScreen && isChromaGreen(
        channel8(decoded, offset, sampleBytes),
        channel8(decoded, offset + sampleBytes, sampleBytes),
        channel8(decoded, offset + sampleBytes * 2, sampleBytes),
      )) continue;
      bodyMinX = Math.min(bodyMinX, x);
      bodyMinY = Math.min(bodyMinY, y);
      bodyMaxX = Math.max(bodyMaxX, x);
      bodyMaxY = Math.max(bodyMaxY, y);
    }
  }
  const body = bodyMaxX >= bodyMinX && bodyMaxY >= bodyMinY
    ? {
        x: bodyMinX,
        y: bodyMinY,
        width: Math.max(1, bodyMaxX - bodyMinX + 1),
        height: Math.max(1, bodyMaxY - bodyMinY + 1),
      }
    : null;
  return {
    x: xSpan.min,
    y: ySpan.min,
    width: Math.max(1, xSpan.max - xSpan.min + 1),
    height: Math.max(1, ySpan.max - ySpan.min + 1),
    canvasWidth: png.width,
    canvasHeight: png.height,
    body,
    weaponAccent: largestMaskBounds(weaponAccentMask, png.width, png.height),
  };
}

function animationLooksAttack(animationId, animationName = "") {
  const text = `${animationId} ${animationName}`.toLowerCase();
  if (/(^|[\s_-])(attack|atk|combo|slash|strike|shoot|shot|fire|skill|cast|stab|punch|kick|bite|claw|parry|counter)(?=$|[\s_-]|\d)/.test(text)
    || /(攻击|攻擊|斩|斬|劈|刺|射击|射擊|技能|格挡|格擋|招架|反击|反擊|砍)/.test(text)) {
    return true;
  }
  return false;
}

function hitboxEnabledByDefault(frameIndex, frameCount, animationId, animationName = "") {
  const text = `${animationId} ${animationName}`.toLowerCase();
  if (/(shoot|shot|fire|cast|projectile|skill)/.test(text)) return true;
  if (frameCount <= 3) return true;
  const start = frameIndex / frameCount;
  const end = (frameIndex + 1) / frameCount;
  return end >= 0.25 && start <= 0.85;
}

function groupCanvasForFrameFiles(frameFiles) {
  const counts = new Map();
  let first = null;
  for (const filePath of frameFiles || []) {
    const bounds = opaqueBoundsForPng(filePath);
    if (!bounds?.canvasWidth || !bounds?.canvasHeight) continue;
    const canvas = { width: bounds.canvasWidth, height: bounds.canvasHeight };
    if (!first) first = canvas;
    const key = `${canvas.width}x${canvas.height}`;
    const entry = counts.get(key) || { ...canvas, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  if (!counts.size) return first || null;
  let best = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best ? { width: best.width, height: best.height } : first;
}

function anchorForFrame(bounds, anchorMode, groupCanvas = null) {
  const canvasWidth = Math.max(1, Number(groupCanvas?.width || bounds.canvasWidth || bounds.width || 1));
  const canvasHeight = Math.max(1, Number(groupCanvas?.height || bounds.canvasHeight || bounds.height || 1));
  return {
    x: anchorMode === "canvas_left_bottom" ? 0 : canvasWidth / 2,
    y: canvasHeight,
  };
}

function normalizeBox(boxName, box) {
  const size = {
    x: Math.max(1, round(box.size?.x || 1)),
    y: Math.max(1, round(box.size?.y || 1)),
  };
  if (boxName === "collisionbox") {
    return {
      offset: {
        x: round(box.offset?.x || 0),
        y: round(collisionOffsetY(size.y)),
      },
      size,
      rotation: 0,
      enabled: box.enabled !== false,
    };
  }
  return {
    offset: {
      x: round(box.offset?.x || 0),
      y: round(box.offset?.y || 0),
    },
    size,
    rotation: round(box.rotation || 0),
    enabled: box.enabled !== false,
  };
}

function estimateFrameBoxes(filePath, options = {}) {
  const type = String(options.type || "actor").toLowerCase();
  if (/(vfx|effect|overlay)/.test(type)) return {};
  const bounds = opaqueBoundsForPng(filePath);
  if (!bounds) return {};
  const anchor = anchorForFrame(bounds, options.anchorMode || "canvas_bottom_center", {
    width: options.groupCanvasWidth,
    height: options.groupCanvasHeight,
  });
  const body = bounds.body || bounds;
  const attackLike = animationLooksAttack(options.animationId, options.animationName);
  const centerX = (body.x + body.width * (attackLike ? 0.62 : 0.5)) - anchor.x;
  const centerY = body.y + body.height / 2 - anchor.y;
  const hurtWidth = clamp(body.width * (attackLike ? 0.88 : 0.78), 8, body.width);
  const hurtHeight = clamp(body.height * 0.82, 8, body.height);
  const collisionWidth = clamp(body.width * 0.42, 6, body.width);
  const collisionHeight = clamp(body.height * 0.72, 6, body.height);
  const boxes = {
    hurtbox: normalizeBox("hurtbox", {
      offset: { x: centerX, y: centerY },
      size: { x: hurtWidth, y: hurtHeight },
      rotation: 0,
      enabled: true,
    }),
    collisionbox: normalizeBox("collisionbox", {
      offset: { x: centerX, y: collisionOffsetY(collisionHeight) },
      size: { x: collisionWidth, y: collisionHeight },
      rotation: 0,
      enabled: true,
    }),
  };
  if (attackLike) {
    const weapon = bounds.weaponAccent;
    if (weapon) {
      boxes.hitbox = normalizeBox("hitbox", {
        offset: {
          x: weapon.x + weapon.width / 2 - anchor.x,
          y: weapon.y + weapon.height / 2 - anchor.y,
        },
        size: {
          x: clamp(weapon.width * 1.08, 8, bounds.canvasWidth),
          y: clamp(weapon.height * 1.08, 6, bounds.canvasHeight),
        },
        rotation: 0,
        enabled: hitboxEnabledByDefault(options.frameIndex || 0, options.frameCount || 1, options.animationId, options.animationName),
      });
      return boxes;
    }
    const bodyLeft = body.x;
    const bodyRight = body.x + body.width;
    const fullLeft = bounds.x;
    const fullRight = bounds.x + bounds.width;
    const leftReach = Math.max(0, bodyLeft - fullLeft);
    const rightReach = Math.max(0, fullRight - bodyRight);
    const direction = rightReach >= leftReach ? 1 : -1;
    const reachStart = direction > 0 ? bodyRight - body.width * 0.05 : fullLeft;
    const reachEnd = direction > 0 ? fullRight : bodyLeft + body.width * 0.05;
    const reachWidth = Math.max(8, Math.abs(reachEnd - reachStart));
    const hitWidth = clamp(reachWidth * 0.78, 8, bounds.width);
    const hitHeight = clamp(body.height * 0.22, 6, body.height);
    const hitCenterX = ((reachStart + reachEnd) / 2) - anchor.x;
    boxes.hitbox = normalizeBox("hitbox", {
      offset: {
        x: hitCenterX,
        y: centerY - hurtHeight * 0.1,
      },
      size: { x: hitWidth, y: hitHeight },
      rotation: 0,
      enabled: hitboxEnabledByDefault(options.frameIndex || 0, options.frameCount || 1, options.animationId, options.animationName),
    });
  }
  return boxes;
}

function frameBoxKey(profileId, animationId, frameIndex) {
  return `${profileId}/${animationId}:${frameIndex}`;
}

function validBox(box) {
  return box
    && Number.isFinite(Number(box.offset?.x))
    && Number.isFinite(Number(box.offset?.y))
    && Number(box.size?.x) > 0
    && Number(box.size?.y) > 0;
}

function frameBoxCoverageIssues(tuning, profileId, animation) {
  const type = String(animation.type || "actor").toLowerCase();
  if (/(vfx|effect|overlay|prop)/.test(type)) return [];
  const required = ["hurtbox", "collisionbox"];
  if (animationLooksAttack(animation.id, animation.name)) required.push("hitbox");
  const issues = [];
  for (const [frameIndex] of (animation.frames || []).entries()) {
    const key = frameBoxKey(profileId, animation.id || animation.name, frameIndex);
    const boxes = tuning?.frame_box_overrides?.[key];
    for (const kind of required) {
      if (!validBox(boxes?.[kind])) issues.push({ key, frameIndex, kind });
    }
  }
  return issues;
}

function clearAnimationBoxOverrides(tuning, profileId, animationId) {
  tuning.frame_box_overrides = tuning.frame_box_overrides && typeof tuning.frame_box_overrides === "object"
    ? tuning.frame_box_overrides
    : {};
  const prefix = `${profileId}/${animationId}:`;
  for (const key of Object.keys(tuning.frame_box_overrides)) {
    if (key.startsWith(prefix)) delete tuning.frame_box_overrides[key];
  }
}

function upsertEstimatedFrameBoxes(tuning, profileId, animation, frameFiles, options = {}) {
  tuning.frame_box_overrides = tuning.frame_box_overrides && typeof tuning.frame_box_overrides === "object"
    ? tuning.frame_box_overrides
    : {};
  if (options.replace) clearAnimationBoxOverrides(tuning, profileId, animation.id);
  const groupCanvas = groupCanvasForFrameFiles(frameFiles);
  frameFiles.forEach((filePath, frameIndex) => {
    const key = frameBoxKey(profileId, animation.id, frameIndex);
    const boxes = estimateFrameBoxes(filePath, {
      type: animation.type,
      anchorMode: animation.anchorMode,
      animationId: animation.id,
      animationName: animation.name,
      frameIndex,
      frameCount: frameFiles.length,
      groupCanvasWidth: groupCanvas?.width,
      groupCanvasHeight: groupCanvas?.height,
    });
    if (!Object.keys(boxes).length) return;
    if (options.replace || !tuning.frame_box_overrides[key]) {
      tuning.frame_box_overrides[key] = boxes;
      return;
    }
    const existing = tuning.frame_box_overrides[key];
    for (const [kind, box] of Object.entries(boxes)) {
      if (!validBox(existing[kind])) existing[kind] = box;
    }
  });
}

module.exports = {
  animationLooksAttack,
  clearAnimationBoxOverrides,
  estimateFrameBoxes,
  frameBoxCoverageIssues,
  frameBoxKey,
  groupCanvasForFrameFiles,
  hitboxEnabledByDefault,
  opaqueBoundsForPng,
  upsertEstimatedFrameBoxes,
  validBox,
};
