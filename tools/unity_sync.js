"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EMPTY_MANIFEST, EMPTY_TUNING, reslash } = require("./project_store");
const { EMPTY_ATTACK_TRAILS, normalizeAttackTrails } = require("./attack_trails");
const { buildRuntimeData, stableBindingKey } = require("./runtime_data");
const { ensureUnityRuntime } = require("./unity_runtime");

const UNITY_ROOT = "Assets/XSXBFrameTuner";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripNonUnityMetadataPaths(value) {
  if (Array.isArray(value)) {
    return value
      .map(stripNonUnityMetadataPaths)
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") {
    if (
      typeof value === "string" &&
      (/workspace\//i.test(value) ||
        /^[A-Za-z]:\\/i.test(value) ||
        /res:\/\//i.test(value))
    ) {
      return undefined;
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, stripNonUnityMetadataPaths(item)])
      .filter(([, item]) => item !== undefined)
  );
}

function unityAssetPath(...parts) {
  return reslash(path.posix.join(UNITY_ROOT, ...parts.map((part) => String(part || ""))));
}

function validUnityProjectRoot(project) {
  const root = project?.projectRoot ? path.resolve(String(project.projectRoot)) : "";
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "";
  if (!fs.existsSync(path.join(root, "Assets")) || !fs.existsSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"))) return "";
  return root;
}

function unitySceneLogicalKey(assetPath) {
  return reslash(assetPath)
    .replace(/^Assets\/_Project\/Scenes\/(?:Production|Runtime)\//i, "")
    .toLowerCase();
}

function listUnitySceneFiles(projectRoot, profiles = []) {
  const root = path.resolve(String(projectRoot || ""));
  const assetsRoot = path.join(root, "Assets");
  if (!fs.existsSync(assetsRoot) || !fs.statSync(assetsRoot).isDirectory()) return [];
  const profileIds = (Array.isArray(profiles) ? profiles : []).map((profile) => String(profile?.id || "")).filter(Boolean);
  const candidates = new Map();

  const addScene = (assetPath, priority) => {
    const normalized = reslash(assetPath);
    if (!/^Assets\/.+\.unity$/i.test(normalized) || /\/Development\//i.test(normalized)) return;
    const fullPath = safeResolve(root, normalized);
    if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
    const logicalKey = unitySceneLogicalKey(normalized);
    const existing = candidates.get(logicalKey);
    if (existing && existing.priority <= priority) return;
    const relativeLabel = normalized
      .replace(/^Assets\/_Project\/Scenes\/(?:Production|Runtime)\//i, "")
      .replace(/^Assets\//i, "")
      .replace(/\.unity$/i, "");
    candidates.set(logicalKey, {
      id: normalized,
      label: relativeLabel.split("/").join(" / "),
      path: normalized,
      profileIds,
      priority,
    });
  };

  const walk = (directory) => {
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^(Development|Runtime)$/i.test(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".unity") continue;
      const assetPath = reslash(path.relative(root, fullPath));
      addScene(assetPath, /\/Production\//i.test(assetPath) ? 0 : 2);
    }
  };
  walk(assetsRoot);

  const buildSettings = path.join(root, "ProjectSettings", "EditorBuildSettings.asset");
  if (fs.existsSync(buildSettings)) {
    const text = fs.readFileSync(buildSettings, "utf8");
    const scenePattern = /-\s+enabled:\s*1\s*\r?\n\s*path:\s*(Assets\/[^\r\n]+\.unity)\s*$/gim;
    for (const match of text.matchAll(scenePattern)) addScene(match[1].trim(), 1);
  }

  return [...candidates.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ priority, ...scene }) => scene);
}

function writeIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (fs.existsSync(filePath) && fs.readFileSync(filePath).equals(next)) return false;
  fs.writeFileSync(filePath, next);
  return true;
}

function writeJson(filePath, value) {
  return writeIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSyncSignal(filePath, projectId) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: 1,
    projectId: String(projectId || ""),
    savedAtUtc: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString("hex"),
  }, null, 2)}\n`, "utf8");
  return true;
}

function safeResolve(base, requested) {
  const resolvedBase = path.resolve(base);
  const full = path.resolve(resolvedBase, String(requested || ""));
  return full === resolvedBase || full.startsWith(`${resolvedBase}${path.sep}`) ? full : null;
}

function sourcePath(root, projectRoot, requested) {
  const raw = String(requested || "");
  if (!raw) return "";
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
  if (raw.startsWith("Assets/")) {
    const inUnity = safeResolve(projectRoot, raw);
    return inUnity && fs.existsSync(inUnity) ? inUnity : "";
  }
  if (raw.startsWith("res://")) {
    const legacyProject = safeResolve(projectRoot, raw.slice(6));
    return legacyProject && fs.existsSync(legacyProject) ? legacyProject : "";
  }
  const inTuner = safeResolve(root, raw);
  if (inTuner && fs.existsSync(inTuner)) return inTuner;
  const inProject = safeResolve(projectRoot, raw);
  return inProject && fs.existsSync(inProject) ? inProject : "";
}

function safeSegment(value, fallback) {
  const text = String(value || fallback).trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, "_").replace(/\.\./g, "_");
  return text.replace(/^_+|_+$/g, "") || fallback;
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyAsset(source, projectRoot, assetPath) {
  if (!source || !fs.existsSync(source)) return false;
  return writeIfChanged(path.join(projectRoot, ...assetPath.split("/")), fs.readFileSync(source));
}

function pruneManagedFrameAssets(projectRoot, projectId, expectedAssetPaths) {
  const managedRoot = path.join(projectRoot, "Assets", "XSXBFrameTuner", "Frames", projectId);
  if (!fs.existsSync(managedRoot)) return 0;
  let removed = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const assetPath = reslash(path.relative(projectRoot, fullPath));
      if (assetPath.endsWith(".meta")) {
        if (!expectedAssetPaths.has(assetPath.slice(0, -5)) && fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        continue;
      }
      if (expectedAssetPaths.has(assetPath)) continue;
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      removed += 1;
      const metaPath = `${fullPath}.meta`;
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    }
  };
  walk(managedRoot);
  return removed;
}

function decodeDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(String(value || ""));
  if (!match) return null;
  return {
    mime: match[1] || "",
    buffer: match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3] || ""), "utf8"),
  };
}

function pruneManagedBakedFrames(projectRoot, projectId, expectedAssetPaths) {
  const managedRoot = path.join(projectRoot, "Assets", "XSXBFrameTuner", "BakedFrames", projectId);
  if (!fs.existsSync(managedRoot)) return 0;
  let removed = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const assetPath = reslash(path.relative(projectRoot, fullPath));
      if (assetPath.endsWith(".meta")) {
        if (!expectedAssetPaths.has(assetPath.slice(0, -5))) fs.unlinkSync(fullPath);
        continue;
      }
      if (expectedAssetPaths.has(assetPath)) continue;
      fs.unlinkSync(fullPath);
      const metaPath = `${fullPath}.meta`;
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      removed += 1;
    }
  };
  walk(managedRoot);
  return removed;
}

function syncBakedFrames(projectRoot, project, input) {
  const frames = [];
  const expectedAssetPaths = new Set();
  let writtenFrames = 0;
  const warnings = [];
  for (const [index, source] of (Array.isArray(input) ? input : []).entries()) {
    const profileId = String(source?.profileId || "");
    const animationId = String(source?.animationId || "");
    const frameIndex = Math.max(0, Math.round(Number(source?.frameIndex || 0)));
    const decoded = decodeDataUrl(source?.data);
    if (!profileId || !animationId || !decoded?.buffer?.length || !/^image\/png$/i.test(decoded.mime)) {
      warnings.push(`Invalid baked frame: ${profileId || "profile"}/${animationId || "animation"}:${frameIndex || index}`);
      continue;
    }
    const assetPath = unityAssetPath(
      "BakedFrames",
      project.id,
      safeSegment(profileId, "profile"),
      safeSegment(animationId, "animation"),
      `${String(frameIndex).padStart(4, "0")}.png`
    );
    expectedAssetPaths.add(assetPath);
    if (writeIfChanged(path.join(projectRoot, ...assetPath.split("/")), decoded.buffer)) writtenFrames += 1;
    frames.push({
      key: `${profileId}/${animationId}:${frameIndex}`,
      profileId,
      animationId,
      frameIndex,
      assetPath,
      width: Math.max(1, Math.round(Number(source?.width || 1))),
      height: Math.max(1, Math.round(Number(source?.height || 1))),
      bakedPixelScale: Math.max(1, Number(source?.bakedPixelScale || 1)),
      offset: {
        x: Number(source?.offset?.x || 0),
        y: Number(source?.offset?.y || 0),
      },
      mainAnchor: {
        x: Number(source?.mainAnchor?.x || 0),
        y: Number(source?.mainAnchor?.y || 0),
      },
    });
  }
  const removedStaleFrames = pruneManagedBakedFrames(projectRoot, project.id, expectedAssetPaths);
  return { frames, writtenFrames, removedStaleFrames, warnings };
}

function extensionForAudio(binding, mime = "") {
  const ext = path.extname(String(binding?.name || binding?.path || "")).toLowerCase();
  if (ext) return ext;
  const type = String(binding?.type || mime).toLowerCase();
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("wav")) return ".wav";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("flac")) return ".flac";
  if (type.includes("aac")) return ".aac";
  return ".bytes";
}

function syncManifest(root, projectRoot, project, input) {
  const manifest = clone(input || EMPTY_MANIFEST);
  let frameCount = 0;
  let copiedFrames = 0;
  const expectedAssetPaths = new Set();
  const warnings = [];
  for (const profile of Array.isArray(manifest.profiles) ? manifest.profiles : []) {
    const profileId = safeSegment(profile.id, "profile");
    for (const animation of Array.isArray(profile.animations) ? profile.animations : []) {
      const animationId = safeSegment(animation.id || animation.name, "animation");
      const frames = Array.isArray(animation.frames) ? animation.frames : [];
      frames.forEach((frame, index) => {
        frameCount += 1;
        const source = sourcePath(root, projectRoot, frame.path);
        const ext = path.extname(source || frame.name || frame.path || ".png").toLowerCase() || ".png";
        const sourceName = path.basename(frame.name || frame.path || `frame${ext}`);
        const stem = path.basename(sourceName, path.extname(sourceName));
        const fileName = `${String(index).padStart(4, "0")}_${safeSegment(stem, "frame")}${ext}`;
        const assetPath = unityAssetPath("Frames", project.id, profileId, animationId, fileName);
        expectedAssetPaths.add(assetPath);
        if (!source) warnings.push(`Missing frame source: ${profile.id}/${animation.id}:${index}`);
        else if (copyAsset(source, projectRoot, assetPath)) copiedFrames += 1;
        frame.path = assetPath;
        frame.assetPath = assetPath;
      });
      animation.source = unityAssetPath("Frames", project.id, profileId, animationId);
    }
  }
  const removedStaleFrames = pruneManagedFrameAssets(projectRoot, project.id, expectedAssetPaths);
  return { manifest, frameCount, copiedFrames, removedStaleFrames, warnings };
}

function syncAudio(root, projectRoot, project, input) {
  const sourceBindings = Array.isArray(input) ? input : Object.entries(input || {}).map(([key, value]) => ({ key, ...(value || {}) }));
  const bindings = [];
  let copiedAudio = 0;
  const warnings = [];
  sourceBindings.forEach((sourceBinding, index) => {
    if (!sourceBinding || typeof sourceBinding !== "object") return;
    const binding = clone(sourceBinding);
    const data = decodeDataUrl(binding.data);
    const source = data ? "" : sourcePath(root, projectRoot, binding.path || binding.file);
    const ext = extensionForAudio(binding, data?.mime);
    const key = safeSegment(stableBindingKey(binding, index), `audio_${index}`);
    const assetPath = unityAssetPath("Audio", project.id, `${key}${ext}`);
    const wrote = data?.buffer?.length
      ? writeIfChanged(path.join(projectRoot, ...assetPath.split("/")), data.buffer)
      : copyAsset(source, projectRoot, assetPath);
    if (wrote) copiedAudio += 1;
    if (!data?.buffer?.length && !source) {
      warnings.push(`Missing audio source: ${binding.name || binding.key || index}`);
      return;
    }
    delete binding.data;
    delete binding.file;
    delete binding.source;
    binding.key = stableBindingKey(binding, index);
    binding.path = assetPath;
    binding.assetPath = assetPath;
    bindings.push(binding);
  });
  return { bindings, copiedAudio, warnings };
}

function syncAttachments(root, projectRoot, project, input) {
  const attachments = [];
  let copiedAttachments = 0;
  const warnings = [];
  (Array.isArray(input) ? input : []).forEach((sourceAttachment, index) => {
    const attachment = clone(sourceAttachment);
    const source = sourcePath(root, projectRoot, attachment.path);
    if (!source) {
      warnings.push(`Missing attachment source: ${attachment.name || attachment.key || index}`);
      return;
    }
    const ext = path.extname(source).toLowerCase() || ".png";
    const hash = attachment.assetHash || hashFile(source);
    const assetPath = unityAssetPath("Attachments", project.id, `${safeSegment(hash, `attachment_${index}`)}${ext}`);
    if (copyAsset(source, projectRoot, assetPath)) copiedAttachments += 1;
    attachment.key = stableBindingKey(attachment, index);
    delete attachment.frameKey;
    attachment.metadata = stripNonUnityMetadataPaths(attachment.metadata);
    attachment.path = assetPath;
    attachment.assetPath = assetPath;
    attachment.assetHash = hash;
    attachments.push(attachment);
  });
  return { attachments, copiedAttachments, warnings };
}

function syncAttackTrails(root, projectRoot, project, input) {
  const trails = normalizeAttackTrails(input || EMPTY_ATTACK_TRAILS);
  trails.presets = [];
  let copiedTrailTextures = 0;
  const warnings = [];
  if (trails.presetTexture?.path) {
    const source = sourcePath(root, projectRoot, trails.presetTexture.path);
    if (source) {
      const ext = path.extname(source).toLowerCase() || ".png";
      const hash = trails.presetTexture.assetHash || hashFile(source);
      const assetPath = unityAssetPath("AttackTrails", project.id, `${safeSegment(hash, "preset_trail")}${ext}`);
      if (copyAsset(source, projectRoot, assetPath)) copiedTrailTextures += 1;
      trails.presetTexture.path = assetPath;
      trails.presetTexture.assetPath = assetPath;
      trails.presetTexture.assetHash = hash;
    } else warnings.push("Missing default attack trail preset texture.");
  }
  for (const [bindingKey, segments] of Object.entries(trails.bindings || {})) {
    (Array.isArray(segments) ? segments : []).forEach((segment, index) => {
      const source = sourcePath(root, projectRoot, segment?.texture?.path);
      if (!source) {
        warnings.push(`Missing attack trail texture: ${bindingKey}:${segment?.id || index}`);
        return;
      }
      const ext = path.extname(source).toLowerCase() || ".png";
      const hash = segment.texture.assetHash || hashFile(source);
      const assetPath = unityAssetPath("AttackTrails", project.id, `${safeSegment(hash, `trail_${index}`)}${ext}`);
      if (copyAsset(source, projectRoot, assetPath)) copiedTrailTextures += 1;
      segment.texture.path = assetPath;
      segment.texture.assetPath = assetPath;
      segment.texture.assetHash = hash;
    });
  }
  return { trails, copiedTrailTextures, warnings };
}

function validateUnitySync(projectRoot, projectId) {
  const errors = [];
  const dataRoot = path.join(projectRoot, "Assets", "XSXBFrameTuner", "RuntimeData", projectId);
  const required = [
    "animation_manifest.json",
    "animation_tuning.json",
    "frame_audio_bindings.json",
    "frame_image_attachments.json",
    "attack_trails.json",
    "baked_frames.json",
    "xsxb_runtime_data.json",
    "xsxb_sync_signal.json",
  ];
  for (const file of required) if (!fs.existsSync(path.join(dataRoot, file))) errors.push(`Missing Unity sync file: ${file}`);
  for (const file of [
    path.join(projectRoot, "Assets", "XSXBFrameTuner", "Runtime", "XsxbRuntimeDatabase.cs"),
    path.join(projectRoot, "Assets", "XSXBFrameTuner", "Runtime", "XsxbFramePlayer.cs"),
    path.join(projectRoot, "Assets", "XSXBFrameTuner", "Runtime", "Editor", "XsxbRuntimeImporter.cs"),
  ]) if (!fs.existsSync(file)) errors.push(`Missing Unity runtime file: ${reslash(path.relative(projectRoot, file))}`);
  const framePlayerPath = path.join(
    projectRoot,
    "Assets",
    "XSXBFrameTuner",
    "Runtime",
    "XsxbFramePlayer.cs"
  );
  if (fs.existsSync(framePlayerPath)) {
    const framePlayerSource = fs.readFileSync(framePlayerPath, "utf8");
    for (const requiredApi of [
      "CurrentAnimationTimeSeconds",
      "TryGetAttachmentLocalPosition",
      "GetAnimationDurationSeconds",
    ]) {
      if (!framePlayerSource.includes(requiredApi)) {
        errors.push(`Unity runtime player is missing required API: ${requiredApi}`);
      }
    }
  }
  const runtimeData = path.join(dataRoot, "xsxb_runtime_data.json");
  if (fs.existsSync(runtimeData)) {
    const text = fs.readFileSync(runtimeData, "utf8");
    if (/workspace\/|[A-Za-z]:\\|res:\/\//i.test(text)) errors.push("Unity runtime data contains a non-Unity asset path.");
    const parsed = JSON.parse(text);
    if (parsed.authoritySchema !== "xsxb-frame-tuner-v1") errors.push("Unity runtime data authority schema is invalid.");
  }
  for (const file of ["animation_manifest.json", "frame_audio_bindings.json", "frame_image_attachments.json", "attack_trails.json"]) {
    const filePath = path.join(dataRoot, file);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, "utf8");
    if (/workspace\/|[A-Za-z]:\\|res:\/\//i.test(text)) errors.push(`${file} contains a non-Unity asset path.`);
  }
  return errors;
}

function syncUnityProject(root, projectStore, project, options = {}) {
  const projectRoot = validUnityProjectRoot(project);
  if (!projectRoot) throw new Error(`Invalid Unity project root: ${project?.projectRoot || "(empty)"}`);
  const paths = projectStore.projectPaths(project);
  const manifestInput = options.manifest || projectStore.readJson(paths.manifest, EMPTY_MANIFEST);
  const tuning = clone(options.tuning || projectStore.readJson(paths.tuning, EMPTY_TUNING));
  const audioInput = options.frameAudioBindings ?? projectStore.readJson(paths.frameAudio, []);
  const attachmentInput = options.frameImageAttachments ?? projectStore.readJson(paths.frameImageAttachments, []);
  const trailInput = options.attackTrails || projectStore.readJson(paths.attackTrails, EMPTY_ATTACK_TRAILS);
  const manifestResult = syncManifest(root, projectRoot, project, manifestInput);
  const audioResult = syncAudio(root, projectRoot, project, audioInput);
  const attachmentResult = syncAttachments(root, projectRoot, project, attachmentInput);
  const trailResult = syncAttackTrails(root, projectRoot, project, trailInput);
  const dataRoot = path.join(projectRoot, "Assets", "XSXBFrameTuner", "RuntimeData", project.id);
  const bakedManifestPath = path.join(dataRoot, "baked_frames.json");
  const bakedResult = options.bakedFrames !== undefined
    ? syncBakedFrames(projectRoot, project, options.bakedFrames)
    : {
        frames: fs.existsSync(bakedManifestPath) ? projectStore.readJson(bakedManifestPath, []) : [],
        writtenFrames: 0,
        removedStaleFrames: 0,
        warnings: [],
      };
  const runtimeTuning = clone(tuning);
  runtimeTuning.scene_settings = Object.fromEntries(
    Object.entries(runtimeTuning.scene_settings || {})
      .map(([scene, value]) => [reslash(scene), value])
      .filter(([scene]) => /^Assets\/.+\.unity$/i.test(scene))
  );
  const runtimeData = buildRuntimeData({
    projectId: project.id,
    manifest: manifestResult.manifest,
    tuning: runtimeTuning,
    frameAudioBindings: audioResult.bindings,
    frameImageAttachments: attachmentResult.attachments,
    attackTrails: trailResult.trails,
    bakedFrames: bakedResult.frames,
  });
  const writes = {
    manifest: writeJson(path.join(dataRoot, "animation_manifest.json"), manifestResult.manifest),
    tuning: writeJson(path.join(dataRoot, "animation_tuning.json"), tuning),
    audio: writeJson(path.join(dataRoot, "frame_audio_bindings.json"), audioResult.bindings),
    attachments: writeJson(path.join(dataRoot, "frame_image_attachments.json"), attachmentResult.attachments),
    attackTrails: writeJson(path.join(dataRoot, "attack_trails.json"), trailResult.trails),
    bakedFrames: writeJson(bakedManifestPath, bakedResult.frames),
    runtimeData: writeJson(path.join(dataRoot, "xsxb_runtime_data.json"), runtimeData),
    syncSignal: writeSyncSignal(path.join(dataRoot, "xsxb_sync_signal.json"), project.id),
  };
  const runtime = ensureUnityRuntime(projectRoot);
  const errors = validateUnitySync(projectRoot, project.id);
  return {
    engine: "unity",
    projectRoot,
    dataRoot: reslash(path.relative(projectRoot, dataRoot)),
    frameCount: manifestResult.frameCount,
    copiedFrames: manifestResult.copiedFrames,
    removedStaleFrames: manifestResult.removedStaleFrames,
    audioCount: audioResult.bindings.length,
    copiedAudio: audioResult.copiedAudio,
    attachmentCount: attachmentResult.attachments.length,
    copiedAttachments: attachmentResult.copiedAttachments,
    copiedTrailTextures: trailResult.copiedTrailTextures,
    bakedFrameCount: bakedResult.frames.length,
    writtenBakedFrames: bakedResult.writtenFrames,
    removedStaleBakedFrames: bakedResult.removedStaleFrames,
    runtimeFilesChanged: runtime.files.filter((entry) => entry.changed).length,
    writes,
    warnings: [...manifestResult.warnings, ...audioResult.warnings, ...attachmentResult.warnings, ...trailResult.warnings, ...bakedResult.warnings],
    errors,
  };
}

module.exports = {
  UNITY_ROOT,
  listUnitySceneFiles,
  syncUnityProject,
  validUnityProjectRoot,
  validateUnitySync,
};
