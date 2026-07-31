"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureUnityRuntime } = require("./unity_runtime");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function makeWritable(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) makeWritable(fullPath);
    try { fs.chmodSync(fullPath, entry.isDirectory() ? 0o777 : 0o666); } catch { /* best effort before removal */ }
  }
  try { fs.chmodSync(root, 0o777); } catch { /* best effort before removal */ }
}

function removeFixture(fixturePath) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(fixturePath);
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith("xsxb-unity-batch-smoke-")) {
    throw new Error(`Refusing to remove non-smoke path: ${resolved}`);
  }
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      makeWritable(resolved);
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw lastError;
}

const unity = path.resolve(argument("unity", "E:/UnityGlobal/Editors/6000.3.20f1/Editor/Unity.exe"));
if (!fs.existsSync(unity)) throw new Error(`Unity executable not found: ${unity}`);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-unity-batch-smoke-"));
const logPath = path.join(fixture, "xsxb-unity-smoke.log");
let succeeded = false;
try {
  fs.mkdirSync(path.join(fixture, "Assets"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "Packages"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "ProjectSettings"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "Packages", "manifest.json"), `${JSON.stringify({ dependencies: {
    "com.unity.modules.audio": "1.0.0",
    "com.unity.modules.jsonserialize": "1.0.0",
    "com.unity.modules.physics2d": "1.0.0",
  } }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(fixture, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.20f1\nm_EditorVersionWithRevision: 6000.3.20f1 (c9ba695d4f07)\n", "utf8");
  ensureUnityRuntime(fixture);
  const frameAssetPath = "Assets/XSXBFrameTuner/Frames/smoke/hero/idle/0000_frame.png";
  const frameFile = path.join(fixture, ...frameAssetPath.split("/"));
  fs.mkdirSync(path.dirname(frameFile), { recursive: true });
  fs.writeFileSync(frameFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const dataRoot = path.join(fixture, "Assets", "XSXBFrameTuner", "RuntimeData", "smoke");
  fs.mkdirSync(dataRoot, { recursive: true });
  const runtimeData = {
    schemaVersion: 1,
    authoritySchema: "xsxb-frame-tuner-v1",
    projectId: "smoke",
    profiles: [{
      id: "hero",
      label: "Hero",
      kind: "actor",
      sourceFacesLeft: false,
      characterTransform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0 },
      animations: [{
        id: "idle", name: "idle", type: "actor", anchorMode: "canvas_bottom_center", fps: 12, durationMs: 83.333,
        frames: [{ index: 0, id: "frame_0001", name: "frame.png", assetPath: frameAssetPath, width: 1, height: 1, durationMs: 83.333, disabled: false, transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0 }, boxes: [], audio: [], attachments: [] }],
        attackTrails: [],
      }],
    }],
    sceneSettings: [],
  };
  fs.writeFileSync(path.join(dataRoot, "xsxb_runtime_data.json"), `${JSON.stringify(runtimeData, null, 2)}\n`, "utf8");
  const result = spawnSync(unity, [
    "-batchmode",
    "-nographics",
    "-quit",
    "-projectPath", fixture,
    "-executeMethod", "XsxbFrameTuner.Editor.XsxbRuntimeImporter.BatchSmoke",
    "-logFile", logPath,
  ], { encoding: "utf8", timeout: 300000 });
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !log.includes("XSXB_UNITY_SMOKE_OK")) {
    process.stderr.write(`${log.slice(-12000)}\n`);
    throw new Error(`Unity batch smoke failed with exit code ${result.status}; fixture retained at ${fixture}`);
  }
  succeeded = true;
  console.log(`XSXB Unity batch smoke passed with ${path.basename(path.dirname(path.dirname(unity)))}.`);
} finally {
  if (succeeded) {
    try {
      removeFixture(fixture);
    } catch (error) {
      process.stderr.write(`Unity smoke passed, but its temporary fixture could not be removed yet: ${fixture} (${error.code || error.message})\n`);
    }
  }
}
