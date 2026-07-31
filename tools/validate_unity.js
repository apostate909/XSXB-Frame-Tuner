"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createProjectStore, projectEngine } = require("./project_store");
const { validUnityProjectRoot, validateUnitySync } = require("./unity_sync");

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function validate(root, options = {}) {
  const store = createProjectStore(root);
  const registry = store.readRegistry();
  const project = store.resolveProject(registry, options.project);
  const errors = [];
  if (!project) errors.push(`Project not found: ${options.project || "(active)"}`);
  else if (projectEngine(project) !== "unity") errors.push(`${project.id} is not a Unity project binding.`);
  const projectRoot = project ? validUnityProjectRoot(project) : "";
  if (project && !projectRoot) errors.push(`Invalid Unity project root: ${project.projectRoot || "(empty)"}`);
  if (projectRoot) errors.push(...validateUnitySync(projectRoot, project.id));
  let summary = {};
  let runtime = null;
  if (projectRoot) {
    const runtimePath = path.join(projectRoot, "Assets", "XSXBFrameTuner", "RuntimeData", project.id, "xsxb_runtime_data.json");
    if (fs.existsSync(runtimePath)) {
      runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
      const profiles = Array.isArray(runtime.profiles) ? runtime.profiles : [];
      summary = {
        project: project.id,
        projectRoot,
        unityVersion: fs.readFileSync(path.join(projectRoot, "ProjectSettings", "ProjectVersion.txt"), "utf8").match(/m_EditorVersion:\s*(.+)/)?.[1]?.trim() || "",
        profiles: profiles.length,
        animations: profiles.reduce((sum, profile) => sum + (profile.animations || []).length, 0),
        frames: profiles.reduce((sum, profile) => sum + (profile.animations || []).reduce((count, animation) => count + (animation.frames || []).length, 0), 0),
      };
    }
    const databasePath = path.join(projectRoot, "Assets", "XSXBFrameTuner", "RuntimeData", project.id, "xsxb_runtime_data.asset");
    if (!fs.existsSync(databasePath)) errors.push("Unity importer has not generated xsxb_runtime_data.asset.");
    else if (runtime) {
      const databaseText = fs.readFileSync(databasePath, "utf8");
      const framePaths = runtime.profiles.flatMap((profile) =>
        (profile.animations || []).flatMap((animation) =>
          (animation.frames || []).map((frame) => frame.assetPath).filter(Boolean)
        )
      );
      const missingFramePaths = framePaths.filter((assetPath) => !databaseText.includes(`  - path: ${assetPath}\n`));
      summary.databaseAssets = (databaseText.match(/^  - path:/gm) || []).length;
      summary.databaseFrameAssets = framePaths.length - missingFramePaths.length;
      if (missingFramePaths.length) {
        errors.push(
          `Unity runtime database is missing ${missingFramePaths.length}/${framePaths.length} frame Sprite references. ` +
          `First missing asset: ${missingFramePaths[0]}`
        );
      }
    }
  }
  return { ok: errors.length === 0, errors, summary };
}

if (require.main === module) {
  const result = validate(path.resolve(__dirname, ".."), args(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

module.exports = { validate };
