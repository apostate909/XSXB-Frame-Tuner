const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { reslash } = require("./project_store");

const DEFAULT_ATTACK_TRAIL_PRESET_TEXTURE = Object.freeze({
  path: "tools/animation_tuner/public/presets/attack_trails/coherent_trail_body_luma.png",
  assetHash: "af5fffcb5009c5eb78bc595d85f72f0bd68e310d5f7926e54512d4f39efb1878",
  name: "coherent_trail_body_luma.png",
  type: "image/png",
  width: 256,
  height: 256,
  hasEffectiveAlpha: false,
});
const LEGACY_PRESET_TEXTURE_PATH = "tools/animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png";
const LEGACY_PRESET_TEXTURE_HASH = "e2b855cdb3c59db8b4ed33f400b03bafd4af7df2636f3fd4d3eb68603763da90";
const DEFAULT_MATERIAL_LAYERS = Object.freeze({
  streaks: Object.freeze({
    enabled: true,
    texture: Object.freeze({
      path: "tools/animation_tuner/public/presets/attack_trails/coherent_breakup_luma.png",
      assetHash: "1702655ad189266dd598355cfc47afbf42bba34c064e423200b5daa6ae13c760",
      name: "coherent_breakup_luma.png",
      type: "image/png",
      width: 256,
      height: 256,
      hasEffectiveAlpha: false,
    }),
    color: "#e93f73",
    strength: 0.46,
    blendMode: "screen",
    invert: false,
    threshold: 0,
    softness: 0,
    expansion: 0,
  }),
  breakup: Object.freeze({
    enabled: true,
    texture: Object.freeze({
      path: "tools/animation_tuner/public/presets/attack_trails/coherent_breakup_luma.png",
      assetHash: "1702655ad189266dd598355cfc47afbf42bba34c064e423200b5daa6ae13c760",
      name: "coherent_breakup_luma.png",
      type: "image/png",
      width: 256,
      height: 256,
      hasEffectiveAlpha: false,
    }),
    color: "#ffffff",
    strength: 0.72,
    blendMode: "normal",
    invert: false,
    threshold: 0,
    softness: 0,
    expansion: 0,
  }),
  core: Object.freeze({
    enabled: true,
    texture: Object.freeze({
      path: "tools/animation_tuner/public/presets/attack_trails/coherent_outer_glow_luma.png",
      assetHash: "fc6b0c707f9cbf57aee0efdc7cb985ae2b8191e65e55dcc4644ecbb37972fd33",
      name: "coherent_outer_glow_luma.png",
      type: "image/png",
      width: 256,
      height: 256,
      hasEffectiveAlpha: false,
    }),
    color: "#ffe7ee",
    strength: 1.05,
    blendMode: "add",
    invert: false,
    threshold: 0,
    softness: 0,
    expansion: 0,
  }),
});
const DEFAULT_TAIL_HEAD_SPEED_RATIO = 0.7;
const DEFAULT_PATH_COLUMNS = 20;
const DEFAULT_GLOW_STRENGTH = 0.28;
const DEFAULT_GLOW_RADIUS = 16;
const DEFAULT_HEAD_LIGHT_BOOST = 0.55;
const DEFAULT_BEFORE_CHASE_MULTIPLIER = 0.5;
const DEFAULT_AFTER_CHASE_MULTIPLIER = 2;
const LEGACY_BEFORE_CHASE_SPEED = 110;
const LEGACY_AFTER_CHASE_SPEED = 680;
const ATTACK_TRAIL_SCHEMA_VERSION = 21;
const EMPTY_ATTACK_TRAILS = Object.freeze({
  schemaVersion: ATTACK_TRAIL_SCHEMA_VERSION,
  presetTexture: DEFAULT_ATTACK_TRAIL_PRESET_TEXTURE,
  presets: Object.freeze([]),
  bindings: {},
});
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function slug(value, fallback) {
  const text = String(value || "").trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return text || fallback;
}

function point(value, fallback = { x: 0, y: 0 }) {
  return {
    x: clamp(value?.x, -100000, 100000, fallback.x),
    y: clamp(value?.y, -100000, 100000, fallback.y),
  };
}

function normalizeTexture(value) {
  const texture = value && typeof value === "object" ? value : {};
  return {
    path: reslash(texture.path || ""),
    assetHash: String(texture.assetHash || ""),
    name: String(texture.name || ""),
    type: String(texture.type || "image/png"),
    width: Math.max(0, Math.round(Number(texture.width || 0))),
    height: Math.max(0, Math.round(Number(texture.height || 0))),
    hasEffectiveAlpha: texture.hasEffectiveAlpha === true,
  };
}

function normalizeBodyTexture(value) {
  const texture = value && typeof value === "object" ? value : {};
  const legacyDefault = reslash(texture.path || "") === LEGACY_PRESET_TEXTURE_PATH
    || String(texture.assetHash || "") === LEGACY_PRESET_TEXTURE_HASH;
  const canonicalDefault = reslash(texture.path || "") === DEFAULT_ATTACK_TRAIL_PRESET_TEXTURE.path;
  return normalizeTexture(!texture.path || legacyDefault || canonicalDefault ? DEFAULT_ATTACK_TRAIL_PRESET_TEXTURE : texture);
}

function normalizeColor(value, fallback = "#d9364a") {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : fallback;
}

function fluorescentHaloColor(value) {
  const color = normalizeColor(value);
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const minimum = Math.min(...channels);
  const maximum = Math.max(...channels);
  const range = maximum - minimum;
  if (range < 3) return color;
  return `#${channels.map((channel) => (
    Math.round(45 + (channel - minimum) / range * 210).toString(16).padStart(2, "0")
  )).join("")}`;
}

function normalizeTrailName(value, index = 0) {
  const name = String(value || "").trim();
  if (!name) return `Trail ${index + 1}`;
  if (/^\?+$/.test(name) || /[\uE000-\uF8FF\uFFFD]/u.test(name)) return "默认拖尾";
  return name;
}

function normalizeColorMode(value) {
  const mode = String(value || "").toLowerCase();
  if (mode === "original" || mode === "gradient") return mode;
  return "solid";
}

function normalizeCoreEdge(value) {
  const edge = String(value || "").toLowerCase();
  return edge === "bottom" || edge === "both" ? edge : "top";
}

function normalizeBlendMode(value, fallback = "add") {
  const mode = String(value || "").toLowerCase();
  return ["add", "screen", "normal", "multiply"].includes(mode) ? mode : fallback;
}

function normalizeMaterialLayers(value, legacy = {}) {
  const source = value && typeof value === "object" ? value : {};
  const legacyEnabled = legacy.layeredMaterial !== false && legacy.layered_material !== false;
  const result = {};
  for (const layerId of ["streaks", "breakup", "core"]) {
    const defaults = DEFAULT_MATERIAL_LAYERS[layerId];
    const material = source[layerId] && typeof source[layerId] === "object" ? source[layerId] : {};
    result[layerId] = {
      enabled: legacyEnabled && material.enabled !== false,
      texture: normalizeTexture(
        material.texture?.path && reslash(material.texture.path) !== defaults.texture.path
          ? material.texture
          : defaults.texture,
      ),
      color: normalizeColor(
        material.color ?? (layerId === "core" ? legacy.coreColor ?? legacy.core_color : undefined),
        defaults.color,
      ),
      strength: clamp(
        material.strength ?? (layerId === "core" ? legacy.coreStrength ?? legacy.core_strength : undefined),
        0,
        2,
        defaults.strength,
      ),
      blendMode: normalizeBlendMode(material.blendMode ?? material.blend_mode, defaults.blendMode),
      invert: material.invert === undefined ? defaults.invert : material.invert === true,
      threshold: clamp(material.threshold, 0, 1, defaults.threshold),
      softness: clamp(material.softness, 0, 1, defaults.softness),
      expansion: clamp(material.expansion, 0, 0.12, defaults.expansion),
    };
  }
  return result;
}

function normalizeGradientStops(value, fallbackColor = "#d9364a") {
  const stops = (Array.isArray(value) ? value : []).slice(0, 16).map((stop, index) => ({
    id: slug(stop?.id, `gradient_stop_${index + 1}`),
    position: clamp(stop?.position ?? stop?.offset, 0, 1, index ? 1 : 0),
    color: normalizeColor(stop?.color, fallbackColor),
  })).sort((a, b) => a.position - b.position);
  if (stops.length >= 2) return stops;
  return [
    { id: "gradient_stop_bottom", position: 0, color: fallbackColor },
    { id: "gradient_stop_top", position: 1, color: fallbackColor },
  ];
}

function normalizeFrameSlices(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [rawFrame, rawSlice] of Object.entries(value)) {
    if (!rawSlice || typeof rawSlice !== "object") continue;
    const frame = Math.max(0, Math.round(clamp(rawFrame, 0, 100000, 0)));
    const tail = clamp(rawSlice.tailProgress ?? rawSlice.tail ?? rawSlice.start, 0, 1, 0);
    const head = clamp(rawSlice.headProgress ?? rawSlice.head ?? rawSlice.end, 0, 1, 1);
    result[String(frame)] = {
      enabled: rawSlice.enabled !== false,
      tailProgress: Math.min(tail, head),
      headProgress: Math.max(tail, head),
    };
  }
  return result;
}

function normalizeStick(value, index, defaultLayer = "behind") {
  const stick = value && typeof value === "object" ? value : {};
  const top = point(stick.top, { x: -60, y: -120 });
  let bottom = point(stick.bottom, { x: 60, y: 120 });
  if (Math.hypot(bottom.x - top.x, bottom.y - top.y) < 1) bottom = { x: top.x, y: top.y + 1 };
  return {
    id: slug(stick.id, `stick_${index + 1}`),
    order: index,
    frame: Math.max(0, Math.round(clamp(stick.frame, 0, 100000, 0))),
    framePhase: clamp(stick.framePhase ?? stick.frame_phase, 0, 1, 0.5),
    phaseMode: String(stick.phaseMode || stick.phase_mode || "auto") === "manual" ? "manual" : "auto",
    headFrame: (stick.headFrame ?? stick.head_frame) !== false,
    headFrameMode: String(stick.headFrameMode || stick.head_frame_mode || "manual") === "auto" ? "auto" : "manual",
    top,
    bottom,
    reverseDirection: stick.reverseDirection === true || stick.reverse_direction === true,
    directionOffset: clamp(stick.directionOffset ?? stick.direction_offset, -180, 180, 0),
    tangentStrength: clamp(stick.tangentStrength ?? stick.tangent_strength, 0, 4, 0.8),
    layer: String(stick.layer || defaultLayer) === "front" ? "front" : "behind",
  };
}

function normalizeFramePhases(sticks) {
  if (sticks.length) {
    sticks.forEach((stick, index) => {
      if (stick.headFrameMode === "auto") stick.headFrame = index === sticks.length - 1;
    });
    sticks[sticks.length - 1].headFrame = true;
  }
  const frames = new Map();
  for (const stick of sticks) {
    if (!stick.headFrame) continue;
    (frames.get(stick.frame) || frames.set(stick.frame, []).get(stick.frame)).push(stick);
  }
  for (const frameSticks of frames.values()) {
    let index = 0;
    while (index < frameSticks.length) {
      if (frameSticks[index].phaseMode === "manual") { index += 1; continue; }
      const start = index;
      while (index < frameSticks.length && frameSticks[index].phaseMode !== "manual") index += 1;
      const lower = start > 0 ? frameSticks[start - 1].framePhase : 0;
      const upper = index < frameSticks.length ? frameSticks[index].framePhase : 1;
      const count = index - start;
      for (let offset = 0; offset < count; offset += 1) frameSticks[start + offset].framePhase = lower + (upper - lower) * (offset + 1) / (count + 1);
    }
    let previous = -0.0001;
    frameSticks.forEach((stick, stickIndex) => {
      const maximum = 1 - (frameSticks.length - 1 - stickIndex) * 0.0001;
      stick.framePhase = clamp(stick.framePhase, previous + 0.0001, maximum, (stickIndex + 1) / (frameSticks.length + 1));
      previous = stick.framePhase;
    });
  }
  return sticks;
}

function normalizeChaseMultiplier(segment, phase, sourceSchema = 6) {
  const before = phase === "before";
  const direct = before
    ? segment.beforeStopChaseMultiplier ?? segment.before_stop_chase_multiplier
    : segment.afterStopChaseMultiplier ?? segment.after_stop_chase_multiplier;
  const fallback = before ? DEFAULT_BEFORE_CHASE_MULTIPLIER : DEFAULT_AFTER_CHASE_MULTIPLIER;
  const min = before ? 0 : 0.1;
  const max = before ? 1 : 20;
  if (direct !== undefined && direct !== null && direct !== "") {
    const normalized = clamp(direct, min, max, fallback);
    if (before && sourceSchema < 6 && Math.abs(normalized - 0.7) < 0.000001) return DEFAULT_BEFORE_CHASE_MULTIPLIER;
    return normalized;
  }
  const legacy = Number(before
    ? segment.beforeStopChaseSpeed ?? segment.before_stop_chase_speed
    : segment.afterStopChaseSpeed ?? segment.after_stop_chase_speed);
  if (!Number.isFinite(legacy)) return fallback;
  const legacyDefault = before ? LEGACY_BEFORE_CHASE_SPEED : LEGACY_AFTER_CHASE_SPEED;
  return clamp(legacy / legacyDefault * fallback, min, max, fallback);
}

function normalizeTailHeadSpeedRatio(segment, sourceSchema = 9) {
  const direct = segment.tailHeadSpeedRatio ?? segment.tail_head_speed_ratio;
  if (direct !== undefined && direct !== null && direct !== "") {
    return clamp(direct, 0.01, 0.9, DEFAULT_TAIL_HEAD_SPEED_RATIO);
  }
  const hasLegacyTiming = [
    "beforeStopChaseMultiplier", "before_stop_chase_multiplier",
    "afterStopChaseMultiplier", "after_stop_chase_multiplier",
    "beforeStopChaseSpeed", "before_stop_chase_speed",
    "afterStopChaseSpeed", "after_stop_chase_speed",
  ].some((key) => Object.prototype.hasOwnProperty.call(segment, key));
  if (sourceSchema <= 9 && hasLegacyTiming) {
    const before = normalizeChaseMultiplier(segment, "before", sourceSchema);
    const after = normalizeChaseMultiplier(segment, "after", sourceSchema);
    const legacyCatchRatio = Math.max(0, 1 - before) / Math.max(0.0001, after);
    return clamp(1 / (1 + legacyCatchRatio), 0.01, 0.9, DEFAULT_TAIL_HEAD_SPEED_RATIO);
  }
  return DEFAULT_TAIL_HEAD_SPEED_RATIO;
}

function normalizeSegment(value, index, bindingKey, sourceSchema = 6) {
  const segment = value && typeof value === "object" ? value : {};
  const [profileId = "", animationId = ""] = String(bindingKey || "").split("/");
  const segmentLayer = String(segment.layer || "behind") === "front" ? "front" : "behind";
  const sticks = normalizeFramePhases((Array.isArray(segment.sticks) ? segment.sticks : [])
    .map((stick, stickIndex) => normalizeStick(stick, stickIndex, segmentLayer))
    .sort((a, b) => a.order - b.order)
    .map((stick, order) => ({ ...stick, order })));
  const color = normalizeColor(segment.color);
  const frameSlices = normalizeFrameSlices(segment.frameSlices ?? segment.frame_slices);
  const materialLayers = normalizeMaterialLayers(segment.materialLayers ?? segment.material_layers, segment);
  return {
    id: slug(segment.id, `trail_${index + 1}`),
    name: normalizeTrailName(segment.name, index),
    profileId: String(segment.profileId || profileId),
    animationId: String(segment.animationId || animationId),
    enabled: segment.enabled !== false,
    generated: segment.generated !== false,
    presetOnly: segment.presetOnly === true && sticks.length === 0,
    coordinateSpace: "group",
    layer: segmentLayer,
    texture: normalizeBodyTexture(segment.texture),
    invertTexture: segment.invertTexture === true || segment.invert_texture === true,
    colorMode: normalizeColorMode(segment.colorMode || segment.color_mode || "solid"),
    color,
    gradientStops: normalizeGradientStops(segment.gradientStops ?? segment.gradient_stops, color),
    bodyOpacityFloor: clamp(segment.bodyOpacityFloor ?? segment.body_opacity_floor, 0, 1, 0),
    bodyDetailStrength: clamp(segment.bodyDetailStrength ?? segment.body_detail_strength, 0, 1, 1),
    bodyWhiteThreshold: clamp(segment.bodyWhiteThreshold ?? segment.body_white_threshold, 0, 1, 1),
    materialLayers,
    coreEdge: normalizeCoreEdge(segment.coreEdge ?? segment.core_edge),
    glowColor: normalizeColor(segment.glowColor ?? segment.glow_color, fluorescentHaloColor(materialLayers.core.color)),
    glowStrength: clamp(segment.glowStrength ?? segment.glow_strength, 0, 3, DEFAULT_GLOW_STRENGTH),
    glowRadius: clamp(segment.glowRadius ?? segment.glow_radius, 0, 60, DEFAULT_GLOW_RADIUS),
    headLightBoost: clamp(segment.headLightBoost ?? segment.head_light_boost, 0, 2, DEFAULT_HEAD_LIGHT_BOOST),
    headWhitePreserve: clamp(segment.headWhitePreserve ?? segment.head_white_preserve, 0, 1, 0),
    headWhiteLength: clamp(segment.headWhiteLength ?? segment.head_white_length, 0, 0.5, 0.18),
    widthMode: (segment.widthMode ?? segment.width_mode) === "fixed" ? "fixed" : "authored",
    fixedWidth: clamp(segment.fixedWidth ?? segment.fixed_width, 8, 600, 160),
    widthScale: clamp(segment.widthScale ?? segment.width_scale, 0.1, 3, 1),
    widthOffset: clamp(segment.widthOffset ?? segment.width_offset, -1, 1, 0),
    widthChaseStrength: clamp(segment.widthChaseStrength ?? segment.width_chase_strength, 0, 1, 1),
    pathScaleX: clamp(segment.pathScaleX ?? segment.path_scale_x, 0.25, 3, 1),
    pathScaleY: clamp(segment.pathScaleY ?? segment.path_scale_y, 0.25, 3, 1),
    totalDurationMs: Math.round(clamp(segment.totalDurationMs ?? segment.total_duration_ms, 0, 60000, 0)),
    tailHeadSpeedRatio: normalizeTailHeadSpeedRatio(segment, sourceSchema),
    tailSamples: Math.round(clamp(segment.tailSamples ?? segment.tail_samples, 4, 8, 5)),
    tailFadeStart: clamp(segment.tailFadeStart ?? segment.tail_fade_start, 0, 0.95, 0.6),
    headCurvature: clamp(segment.headCurvature ?? segment.head_curvature, -1, 1, 0),
    speedVariation: clamp(segment.speedVariation ?? segment.speed_variation, 0, 0.25, 0.008),
    stableSeed: Math.round(clamp(segment.stableSeed ?? segment.stable_seed, 0, 2147483647, 73129)),
    pathColumns: Math.round(clamp(segment.pathColumns ?? segment.path_columns, 8, 96, DEFAULT_PATH_COLUMNS)),
    pathCacheSamples: Math.round(clamp(segment.pathCacheSamples ?? segment.path_cache_samples, 32, 512, 192)),
    collapsedWidth: clamp(segment.collapsedWidth ?? segment.collapsed_width, 0.25, 32, 2),
    sticks,
    ...(frameSlices ? { frameSlices } : {}),
  };
}

function normalizeAttackTrails(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sourceSchema = Math.max(0, Math.round(Number(source.schemaVersion || 0)));
  const presetTexture = normalizeBodyTexture(source.presetTexture);
  const presets = [];
  const presetIds = new Set();
  const addPreset = (rawPreset, bindingKey = "preset/global") => {
    const preset = normalizeSegment({
      ...(rawPreset && typeof rawPreset === "object" ? rawPreset : {}),
      generated: false,
      presetOnly: true,
      sticks: [],
    }, presets.length, bindingKey, sourceSchema);
    if (presetIds.has(preset.id)) return;
    presetIds.add(preset.id);
    presets.push(preset);
  };
  for (const preset of Array.isArray(source.presets) ? source.presets : []) {
    addPreset(preset, `${preset?.profileId || "preset"}/${preset?.animationId || "global"}`);
  }
  const bindings = {};
  for (const [rawKey, rawSegments] of Object.entries(source.bindings || {})) {
    const key = String(rawKey || "").trim();
    if (!key.includes("/") || !Array.isArray(rawSegments)) continue;
    const segments = [];
    for (const rawSegment of rawSegments) {
      const segment = normalizeSegment(rawSegment, segments.length, key, sourceSchema);
      if (segment.presetOnly) addPreset(segment, key);
      else segments.push(segment);
    }
    if (segments.length) bindings[key] = segments;
  }
  return { schemaVersion: ATTACK_TRAIL_SCHEMA_VERSION, presetTexture, presets, bindings };
}

function pngInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("攻击拖尾纹理目前仅支持 PNG。请导入 PNG 文件。");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height) throw new Error("PNG 缺少有效 IHDR。");
  let hasEffectiveAlpha = false;
  if ((colorType === 4 || colorType === 6) && bitDepth === 8 && interlace === 0 && idat.length) {
    const channels = colorType === 6 ? 4 : 2;
    const rowBytes = width * channels;
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    let cursor = 0;
    let previous = Buffer.alloc(rowBytes);
    for (let y = 0; y < height && !hasEffectiveAlpha; y += 1) {
      const filter = inflated[cursor++];
      const raw = inflated.subarray(cursor, cursor + rowBytes);
      cursor += rowBytes;
      const row = Buffer.alloc(rowBytes);
      for (let x = 0; x < rowBytes; x += 1) {
        const left = x >= channels ? row[x - channels] : 0;
        const up = previous[x] || 0;
        const upLeft = x >= channels ? previous[x - channels] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = Math.floor((left + up) / 2);
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
        } else if (filter !== 0) {
          throw new Error("不支持此 PNG 过滤器。");
        }
        row[x] = (raw[x] + predictor) & 255;
      }
      for (let x = channels - 1; x < rowBytes; x += channels) {
        if (row[x] < 255) {
          hasEffectiveAlpha = true;
          break;
        }
      }
      previous = row;
    }
  }
  return { width, height, bitDepth, colorType, hasAlphaChannel: colorType === 4 || colorType === 6, hasEffectiveAlpha };
}

function decodeImageDataUrl(value) {
  const match = /^data:(image\/png);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(value || ""));
  if (!match) throw new Error("攻击拖尾纹理必须是 PNG data URL。");
  return { type: match[1].toLowerCase(), buffer: Buffer.from(match[2], "base64") };
}

function saveAttackTrailTexture(root, projectStore, project, payload) {
  const decoded = decodeImageDataUrl(payload.data);
  const info = pngInfo(decoded.buffer);
  const hash = crypto.createHash("sha256").update(decoded.buffer).digest("hex");
  const profileId = slug(payload.profileId, "profile");
  const animationId = slug(payload.animationId, "animation");
  const fullPath = path.join(projectStore.projectWorkspaceDir(project), "attack_trails", profileId, animationId, `${hash}.png`);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, decoded.buffer);
  return {
    path: reslash(path.relative(root, fullPath)),
    assetHash: hash,
    name: String(payload.name || `${hash}.png`),
    type: decoded.type,
    width: info.width,
    height: info.height,
    hasEffectiveAlpha: info.hasEffectiveAlpha,
  };
}

function validateAttackTrails(data, manifest) {
  const warnings = [];
  const profileAnimations = new Set();
  for (const profile of manifest?.profiles || []) {
    for (const animation of profile.animations || []) profileAnimations.add(`${profile.id}/${animation.id || animation.name}`);
  }
  for (const [key, segments] of Object.entries(data?.bindings || {})) {
    if (!profileAnimations.has(key)) warnings.push(`${key}: 攻击拖尾绑定的动画不存在。`);
    for (const segment of segments) {
      if (segment.presetOnly === true) continue;
      if (!segment.texture?.path) warnings.push(`${key}/${segment.id}: 尚未导入拖尾纹理。`);
      if (segment.sticks.length < 2) warnings.push(`${key}/${segment.id}: 至少需要两根棍子。`);
      if (segment.colorMode === "original" && !segment.texture?.hasEffectiveAlpha) {
        warnings.push(`${key}/${segment.id}: 使用贴图原色需要带有效 Alpha 的透明 RGBA PNG。`);
      }
    }
  }
  return warnings;
}

module.exports = {
  DEFAULT_ATTACK_TRAIL_PRESET_TEXTURE,
  EMPTY_ATTACK_TRAILS,
  clone,
  normalizeAttackTrails,
  pngInfo,
  saveAttackTrailTexture,
  validateAttackTrails,
};
