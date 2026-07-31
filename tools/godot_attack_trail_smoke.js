const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

const godot = path.resolve(argument("godot"));
const requestedOutput = argument("out");
const renderSmoke = process.argv.includes("--render");
if (!godot || !fs.existsSync(godot)) {
  throw new Error(`Godot executable not found: ${godot || "(empty)"}`);
}

const root = path.resolve(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-godot-trail-smoke-"));
const runtimeDir = path.join(fixture, "xsxb_frame_tuner", "runtime");
fs.mkdirSync(runtimeDir, { recursive: true });
fs.copyFileSync(
  path.join(root, "tools", "runtime", "xsxb_attack_trail.gdshader"),
  path.join(runtimeDir, "xsxb_attack_trail.gdshader"),
);
fs.copyFileSync(
  path.join(root, "tools", "runtime", "xsxb_attack_trail_renderer.gd"),
  path.join(runtimeDir, "xsxb_attack_trail_renderer.gd"),
);
fs.writeFileSync(path.join(fixture, "project.godot"), [
  "[application]",
  'config/name="XSXB attack trail smoke"',
  "",
  "[rendering]",
  'renderer/rendering_method="gl_compatibility"',
  "",
].join("\n"), "utf8");
fs.writeFileSync(path.join(fixture, "smoke.gd"), [
  "extends SceneTree",
  "",
  "func _initialize() -> void:",
  '\tcall_deferred("_run")',
  "",
  "func _run() -> void:",
  '\tvar shader: Shader = load("res://xsxb_frame_tuner/runtime/xsxb_attack_trail.gdshader") as Shader',
  '\tvar renderer_script: Script = load("res://xsxb_frame_tuner/runtime/xsxb_attack_trail_renderer.gd") as Script',
  "\tif shader == null or renderer_script == null:",
  '\t\tpush_error("XSXB_GODOT_TRAIL_SMOKE_LOAD_FAILED")',
  "\t\tquit(1)",
  "\t\treturn",
  "\tvar viewport := SubViewport.new()",
  "\tviewport.size = Vector2i(320, 200)",
  "\tviewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS",
  "\troot.add_child(viewport)",
  "\tvar background := ColorRect.new()",
  "\tbackground.color = Color(0.015, 0.018, 0.024, 1.0)",
  "\tbackground.size = Vector2(320, 200)",
  "\tviewport.add_child(background)",
  "\tvar body_image := Image.create(64, 64, false, Image.FORMAT_RGBA8)",
  "\tbody_image.fill(Color.WHITE)",
  "\tvar core_image := Image.create(64, 64, false, Image.FORMAT_RGBA8)",
  "\tcore_image.fill(Color.BLACK)",
  "\tfor y in range(5):",
  "\t\tfor x in range(64):",
  "\t\t\tcore_image.set_pixel(x, y, Color.WHITE)",
  "\tvar body_texture := ImageTexture.create_from_image(body_image)",
  "\tvar core_texture := ImageTexture.create_from_image(core_image)",
  "\tvar mesh := ArrayMesh.new()",
  "\tvar arrays := []",
  "\tarrays.resize(Mesh.ARRAY_MAX)",
  "\tarrays[Mesh.ARRAY_VERTEX] = PackedVector2Array([Vector2(40, 20), Vector2(280, 20), Vector2(280, 180), Vector2(40, 180)])",
  "\tarrays[Mesh.ARRAY_TEX_UV] = PackedVector2Array([Vector2(0, -0.25), Vector2(1, -0.25), Vector2(1, 1.25), Vector2(0, 1.25)])",
  "\tarrays[Mesh.ARRAY_INDEX] = PackedInt32Array([0, 1, 2, 0, 2, 3])",
  "\tmesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)",
  "\tvar material := ShaderMaterial.new()",
  "\tmaterial.shader = shader",
  '\tmaterial.set_shader_parameter("trail_texture", body_texture)',
  '\tmaterial.set_shader_parameter("trail_color", Color("#52101f"))',
  '\tmaterial.set_shader_parameter("tail_fade_start", 0.92)',
  '\tmaterial.set_shader_parameter("enable_breakup", false)',
  '\tmaterial.set_shader_parameter("enable_streaks", false)',
  '\tmaterial.set_shader_parameter("enable_core", true)',
  '\tmaterial.set_shader_parameter("core_texture", core_texture)',
  '\tmaterial.set_shader_parameter("core_color", Color("#fff2f7"))',
  '\tmaterial.set_shader_parameter("core_strength", 0.8)',
  '\tmaterial.set_shader_parameter("glow_color", Color("#ff0055"))',
  '\tmaterial.set_shader_parameter("glow_strength", 1.2)',
  '\tmaterial.set_shader_parameter("glow_radius_uv", 0.18)',
  "\tvar mesh_instance := MeshInstance2D.new()",
  "\tmesh_instance.mesh = mesh",
  "\tmesh_instance.material = material",
  "\tviewport.add_child(mesh_instance)",
  "\tawait process_frame",
  "\tawait process_frame",
  "\tawait process_frame",
  "\tvar capture := viewport.get_texture().get_image()",
  '\tvar capture_error := capture.save_png("res://attack_trail_glow_smoke.png")',
  "\tvar outside_glow := capture.get_pixel(160, 36)",
  "\tif capture_error != OK or outside_glow.r < 0.08 or outside_glow.r <= outside_glow.g * 1.35:",
  '\t\tpush_error("XSXB_GODOT_TRAIL_GLOW_MISSING outside=%s" % outside_glow)',
  "\t\tquit(1)",
  "\t\treturn",
  '\tprint("XSXB_GODOT_TRAIL_SMOKE_OK")',
  "\tquit(0)",
  "",
].join("\n"), "utf8");

try {
  const result = spawnSync(godot, [
    ...(renderSmoke ? [] : ["--headless"]),
    "--path", fixture,
    "--script", "res://smoke.gd",
  ], {
    encoding: "utf8",
    timeout: 60000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0 || !output.includes("XSXB_GODOT_TRAIL_SMOKE_OK")) {
    throw new Error(`Godot attack-trail smoke failed with exit code ${result.status}`);
  }
  if (requestedOutput) {
    const outputPath = path.resolve(requestedOutput);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(path.join(fixture, "attack_trail_glow_smoke.png"), outputPath);
    process.stdout.write(`Godot glow capture: ${outputPath}\n`);
  }
} finally {
  const resolvedFixture = path.resolve(fixture);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (resolvedFixture.startsWith(`${resolvedTemp}${path.sep}`) && path.basename(resolvedFixture).startsWith("xsxb-godot-trail-smoke-")) {
    fs.rmSync(resolvedFixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
