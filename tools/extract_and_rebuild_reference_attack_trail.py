from __future__ import annotations

import argparse
import hashlib
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


SIZE = 256
CANVAS_WIDTH = 400
CANVAS_HEIGHT = 331
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "exports" / "参考图原样提取_四层拖尾_待确认"

TEXTURE_CROPS = {
    "edge": (54, 99, 203, 248),
    "body": (1051, 99, 1200, 248),
    "shared_left": (54, 473, 203, 622),
    "shared_right": (1051, 473, 1200, 622),
}

EFFECT_CROPS = {
    "edge": (235, 34, 606, 365),
    "body": (600, 34, 995, 365),
    "mask": (225, 390, 625, 715),
    "color": (590, 390, 995, 715),
}

EDGE_FILE = OUTPUT / "01_亮边_原图提取.png"
BODY_FILE = OUTPUT / "02_基础纹理_原图提取.png"
SHARED_FILE = OUTPUT / "03_抠除纹理_原图提取.png"
SHARED_COPY_FILE = OUTPUT / "04_颜色纹理_与03字节相同.png"
TEXTURE_SHEET = OUTPUT / "四张原图提取对照.png"
EFFECT_SHEET = OUTPUT / "原视频与贴图重建效果对照.png"
HEAD_DETAIL_SHEET = OUTPUT / "第二层首部白色刷头局部对照.png"
FINAL_STAGE_SHEET = OUTPUT / "第四层终产物直接对照.png"


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in [
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
    ]:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def luma(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("L"), dtype=np.float32) / 255.0


def to_luma(value: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(value * 255.0, 0, 255).astype(np.uint8), "L")


def normalize_capture(image: Image.Image) -> np.ndarray:
    value = np.asarray(image.convert("L"), dtype=np.float32)
    low, high = np.percentile(value, [1.0, 99.0])
    normalized = np.clip((value - low) / max(1.0, high - low), 0.0, 1.0)
    restored = Image.fromarray((normalized * 255.0).astype(np.uint8), "L")
    restored = restored.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    return luma(restored)


def extract_textures(reference: Image.Image) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    edge = normalize_capture(reference.crop(TEXTURE_CROPS["edge"]))
    body = normalize_capture(reference.crop(TEXTURE_CROPS["body"]))
    shared_left = normalize_capture(reference.crop(TEXTURE_CROPS["shared_left"]))
    shared_right = normalize_capture(reference.crop(TEXTURE_CROPS["shared_right"]))
    # The left bottom tile is the layer-3 source shown by the reference. Keep
    # that capture intact; averaging the two screen previews removed exactly
    # the small irregularities that make the authored brush look organic.
    # Layer 4 is emitted later as a byte-for-byte copy of this one source.
    shared = shared_left
    return edge, body, shared


def save_textures(edge: np.ndarray, body: np.ndarray, shared: np.ndarray) -> None:
    to_luma(edge).convert("RGB").save(EDGE_FILE, optimize=True)
    to_luma(body).convert("RGB").save(BODY_FILE, optimize=True)
    to_luma(shared).convert("RGB").save(SHARED_FILE, optimize=True)
    shutil.copyfile(SHARED_FILE, SHARED_COPY_FILE)


def smoothstep(edge0: float, edge1: float, value: np.ndarray) -> np.ndarray:
    phase = np.clip((value - edge0) / max(1e-6, edge1 - edge0), 0.0, 1.0)
    return phase * phase * (3.0 - 2.0 * phase)


def arc_coordinates(
    canvas_size: tuple[int, int] = (CANVAS_WIDTH, CANVAS_HEIGHT),
    center: tuple[float, float] = (215.0, 145.0),
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    width, height = canvas_size
    yy, xx = np.indices((height, width), dtype=np.float32)
    center_x, center_y = center
    dx = xx - center_x
    dy = center_y - yy
    radius = np.sqrt(dx * dx + dy * dy)
    angle = np.degrees(np.arctan2(dy, dx))
    angle = np.where(angle < 0.0, angle + 360.0, angle)
    start, end = 132.0, 326.0
    u = (angle - start) / (end - start)
    v = (158.0 - radius) / 82.0
    valid = (u >= 0.0) & (u <= 1.0) & (v >= 0.0) & (v <= 1.0)
    return u, v, valid


def warp_luma(
    texture: np.ndarray,
    canvas_size: tuple[int, int] = (CANVAS_WIDTH, CANVAS_HEIGHT),
    center: tuple[float, float] = (215.0, 145.0),
    flow_strength: float = 0.0,
) -> np.ndarray:
    u, v, valid = arc_coordinates(canvas_size, center)
    source_x = np.clip(u * (SIZE - 1), 0.0, SIZE - 1)
    # The captured texture is not painted on perfectly concentric tracks.
    # Preserve that hand-brushed drift when it is wrapped onto the arc. The
    # same mapping is used for layers 3 and 4 so their silhouettes coincide.
    flow = flow_strength * (
        0.030 * np.sin(2.0 * np.pi * (1.17 * u + 0.78 * v) + 0.65)
        + 0.018 * np.sin(2.0 * np.pi * (3.31 * u - 1.34 * v) + 1.70)
        + 0.008 * np.sin(2.0 * np.pi * (6.73 * u + 2.02 * v) + 0.20)
    )
    source_y = np.clip((v + flow) * (SIZE - 1), 0.0, SIZE - 1)
    x0 = np.floor(source_x).astype(np.int32)
    y0 = np.floor(source_y).astype(np.int32)
    x1 = np.minimum(x0 + 1, SIZE - 1)
    y1 = np.minimum(y0 + 1, SIZE - 1)
    fx = source_x - x0
    fy = source_y - y0
    sampled = (
        texture[y0, x0] * (1.0 - fx) * (1.0 - fy)
        + texture[y0, x1] * fx * (1.0 - fy)
        + texture[y1, x0] * (1.0 - fx) * fy
        + texture[y1, x1] * fx * fy
    )
    return np.where(valid, sampled, 0.0)


def grid_background(
    size: tuple[int, int] = (CANVAS_WIDTH, CANVAS_HEIGHT),
) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size, "#535156")
    draw = ImageDraw.Draw(image)
    for position in range(0, width + 1, 86):
        draw.line((position, 0, position, height), fill="#37383b", width=2)
    for position in range(0, height + 1, 86):
        draw.line((0, position, width, position), fill="#37383b", width=2)
    return image


def alpha_over(base: np.ndarray, color: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    return base * (1.0 - alpha[:, :, None]) + color * alpha[:, :, None]


def render_stage(
    edge: np.ndarray,
    body: np.ndarray,
    shared: np.ndarray,
    stage: int,
) -> Image.Image:
    stage_center = {
        1: (205.0, 137.0),
        2: (215.0, 136.0),
        3: (216.0, 156.0),
        4: (226.0, 156.0),
    }[stage]
    edge_arc = warp_luma(edge, center=stage_center)
    body_arc = warp_luma(body, center=stage_center)
    shared_arc = warp_luma(shared, center=stage_center)
    # Layer 3 and layer 4 sample the captured shared texture as-is. Do not
    # enlarge, close, blur, or otherwise redraw its marks.
    expanded_shared_arc = shared_arc
    softened_edge = luma(
        to_luma(edge_arc).filter(ImageFilter.GaussianBlur(0.80))
    )
    # The source edge texture contains a wide grey shoulder around a very thin
    # white core.  Keeping that shoulder made the rebuild read as a clean,
    # sticker-like outline.  Use only the authored high-energy core; its blur
    # below supplies the surrounding pink emission.
    edge_mask = smoothstep(0.26, 0.72, softened_edge)
    u, v, valid = arc_coordinates(center=stage_center)
    carrier = valid.astype(np.float32)
    angular_start_aa = smoothstep(0.0, 0.008, u)
    carrier *= angular_start_aa
    edge_mask *= angular_start_aa
    if stage >= 3:
        final_head_zone = 1.0 - smoothstep(0.14, 0.24, u)
        edge_mask *= 1.0 - 0.62 * final_head_zone
    # The breakup/color passes leave several hair-like marks beyond the broad
    # layer-2 wash.  Let those stages travel farther before fading; the shared
    # mask below still prevents this from becoming a solid tail wedge.
    tail_fade_start = 0.84 if stage >= 3 else 0.76
    carrier *= 1.0 - smoothstep(tail_fade_start, 1.0, u)
    carrier *= smoothstep(0.0, 0.025, v) * (1.0 - smoothstep(0.96, 1.0, v))
    # Do not sculpt a second procedural wedge over the captured texture. The
    # layer-2 image already contains its full white leading head. The previous
    # radial delay reached 14.5% of the arc at the inner edge and literally
    # cut a triangular hole out of that authored head.
    body_lead = np.ones_like(u, dtype=np.float32)
    # Protect the authored white leading cap. It must remain white through all
    # later color passes and removes the spurious red strip at the cap boundary.
    # The reference cap is short in the radial direction but spreads farther
    # along the stroke.  Protecting the full band made a long white diamond.
    head_depth = 1.0 - smoothstep(0.56, 0.70, v)
    head_protect = (
        carrier
        * (1.0 - smoothstep(0.015, 0.140, u))
        * head_depth
        * body_lead
    )
    result = np.asarray(grid_background(), dtype=np.float32)

    red = np.array([250.0, 48.0, 116.0])[None, None, :]
    white = np.full((1, 1, 3), 255.0, dtype=np.float32)
    # Match the Tuner/Godot material contract: layer 2 uses luminance for
    # color detail while keeping a configurable dark-color body. Bright texels
    # return toward white instead of becoming brighter red.
    authored_detail = 0.44 + 0.50 * body_arc
    body_detail = 1.0 + (authored_detail - 1.0) * 0.18
    body_color = red * body_detail[:, :, None]
    body_ramp = smoothstep(0.84, 0.97, body_arc)
    fiber_ramp = smoothstep(0.54, 0.88, body_arc)
    displayed_body_ramp = np.maximum(
        fiber_ramp * 0.30,
        body_ramp * (1.0 - smoothstep(0.035, 0.095, u)),
    )
    body_color = (
        body_color * (1.0 - displayed_body_ramp[:, :, None])
        + white * displayed_body_ramp[:, :, None]
    )
    # Layer 2 is a brush carrier, not an opaque ribbon.  Most of its dark
    # texels must stay translucent so layer 3 can open real gaps instead of
    # merely drawing slightly darker stripes over a solid pink sheet.
    body_alpha = carrier * (0.82 + 0.18 * body_arc) * body_lead
    final_head_white = (
        body_ramp
        * (1.0 - smoothstep(0.035, 0.095, u))
        * carrier
        * body_lead
    )
    white_body_fibers = fiber_ramp * carrier * body_lead
    color_overlay_alpha = np.zeros_like(body_alpha)
    deep_magenta = np.array([42.0, 0.0, 21.0])[None, None, :]

    if stage == 1:
        body_alpha = np.zeros_like(body_alpha)
    elif stage >= 3:
        # Bright marks in the shared texture are the surviving brush ribbons;
        # its dark field removes the layer-2 carrier around them. Layer 4 uses
        # this exact mask again, so breakup and color cannot drift apart.
        shared_mask = smoothstep(0.040, 0.280, expanded_shared_arc)
        body_alpha *= 1.0 - 0.18 * (1.0 - shared_mask)
        if stage == 4:
            wine = np.array([112.0, 0.0, 52.0])[None, None, :]
            wine_amount = (
                0.82
                * (1.0 - final_head_white)
                * (1.0 - 0.82 * displayed_body_ramp)
            )[:, :, None]
            body_color = body_color * (1.0 - wine_amount) + wine * wine_amount
            amount = (
                np.power(shared_mask, 0.90)
                * (1.0 - final_head_white)
                * (1.0 - 0.72 * displayed_body_ramp)
            )[:, :, None]
            body_color = body_color * (1.0 - amount) + deep_magenta * amount

    if stage >= 2:
        body_opacity = 0.64 if stage == 2 else 1.00
        result = alpha_over(result, body_color, np.clip(body_alpha * body_opacity, 0.0, 1.0))
        if stage == 2:
            result = alpha_over(
                result,
                np.broadcast_to(white, result.shape),
                np.clip(white_body_fibers * 0.68, 0.0, 1.0),
            )
        body_glow = luma(
            to_luma(body_alpha).filter(ImageFilter.GaussianBlur(30.0))
        )
        local_glow_strength = 0.34 if stage == 2 else 0.00
        result += red * np.clip(
            body_glow * local_glow_strength,
            0.0,
            1.0,
        )[:, :, None]
        wide_body_glow = luma(
            to_luma(body_alpha).filter(ImageFilter.GaussianBlur(55.0))
        )
        wide_glow_strength = 0.15 if stage == 2 else 0.00
        result += red * np.clip(
            wide_body_glow * wide_glow_strength,
            0.0,
            1.0,
        )[:, :, None]

    pink_glow = np.array([255.0, 20.0, 105.0])[None, None, :]
    tight_edge_glow = luma(
        to_luma(edge_mask).filter(ImageFilter.GaussianBlur(8.0))
    )
    result += pink_glow * np.clip(
        tight_edge_glow * (1.18 if stage >= 2 else 0.42),
        0.0,
        1.0,
    )[:, :, None]
    glow_radius = 30.0 if stage >= 2 else 11.0
    glow_strength = 2.20 if stage == 4 else (1.62 if stage >= 2 else 0.32)
    white_energy = edge_mask
    if stage >= 2:
        if stage == 2:
            white_energy = np.maximum(
                white_energy,
                np.maximum(head_protect, body_alpha * body_ramp),
            )
            white_energy = np.maximum(white_energy, white_body_fibers)
        else:
            white_energy = np.maximum(
                white_energy,
                np.maximum(final_head_white, body_alpha * body_ramp),
            )
    glow = luma(to_luma(white_energy).filter(ImageFilter.GaussianBlur(glow_radius)))
    result += pink_glow * np.clip(glow * glow_strength, 0.0, 1.0)[:, :, None]
    wide_white_glow = luma(
        to_luma(white_energy).filter(ImageFilter.GaussianBlur(58.0))
    )
    result += pink_glow * np.clip(
        wide_white_glow
        * (0.86 if stage == 4 else (0.38 if stage >= 2 else 0.08)),
        0.0,
        1.0,
    )[:, :, None]

    core_color = np.array([255.0, 246.0, 250.0])[None, None, :]
    result = alpha_over(result, np.broadcast_to(core_color, result.shape), edge_mask)
    if stage >= 2:
        visible_head_white = final_head_white
        visible_head_white = luma(
            to_luma(visible_head_white).filter(ImageFilter.GaussianBlur(0.75))
        )
        head_overlay_strength = 0.58 if stage == 2 else 0.72
        result = alpha_over(
            result,
            np.broadcast_to(white, result.shape),
            np.clip(visible_head_white * head_overlay_strength, 0.0, 1.0),
        )
    if stage == 4:
        softened_result = np.asarray(
            Image.fromarray(
                np.clip(result, 0.0, 255.0).astype(np.uint8),
                "RGB",
            ).filter(ImageFilter.GaussianBlur(2.00)),
            dtype=np.float32,
        )
        head_soft_zone = (
            final_head_zone
            * carrier
            * (1.0 - smoothstep(0.62, 0.82, v))
        )
        head_soft_zone = luma(
            to_luma(head_soft_zone).filter(ImageFilter.GaussianBlur(1.6))
        )
        head_soft_alpha = np.clip(head_soft_zone * 0.65, 0.0, 1.0)
        result = (
            result * (1.0 - head_soft_alpha[:, :, None])
            + softened_result * head_soft_alpha[:, :, None]
        )
    return Image.fromarray(np.clip(result, 0.0, 255.0).astype(np.uint8), "RGB")


def fit_panel(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    panel = Image.new("RGB", size, "#20242a")
    copy = image.copy()
    copy.thumbnail(size, Image.Resampling.LANCZOS)
    left = (size[0] - copy.width) // 2
    top = (size[1] - copy.height) // 2
    panel.paste(copy, (left, top))
    return panel


def texture_sheet(edge: np.ndarray, body: np.ndarray, shared: np.ndarray) -> None:
    sheet = Image.new("RGB", (1228, 382), "#11151b")
    draw = ImageDraw.Draw(sheet)
    draw.text((24, 16), "从原视频画面直接提取的四张贴图", fill="#f6df8b", font=font(24))
    items = [
        (edge, "1 亮边", "原图裁正，仅放大"),
        (body, "2 基础纹理", "原图裁正，仅放大"),
        (shared, "3 抠除", "左右两处同图取样降噪"),
        (shared, "4 颜色", "与第3张字节级一致"),
    ]
    for index, (value, title, subtitle) in enumerate(items):
        left = 24 + index * 300
        sheet.paste(to_luma(value).convert("RGB"), (left, 64))
        draw.rectangle((left - 1, 63, left + SIZE, 320), outline="#6d7c90")
        draw.text((left, 328), title, fill="#ffd84d", font=font(18))
        draw.text((left, 354), subtitle, fill="#c8d2df", font=font(14))
    sheet.save(TEXTURE_SHEET, optimize=True)


def effect_sheet(
    reference: Image.Image,
    edge: np.ndarray,
    body: np.ndarray,
    shared: np.ndarray,
) -> None:
    panel_width, panel_height = 300, 248
    margin, label_height, header_height = 18, 34, 50
    width = margin + (panel_width + margin) * 4
    height = header_height + (panel_height + label_height + margin) * 2
    sheet = Image.new("RGB", (width, height), "#11151b")
    draw = ImageDraw.Draw(sheet)
    draw.text((18, 13), "原视频阶段（上） / 使用提取贴图重建（下）", fill="#f6df8b", font=font(22))
    stages = [
        ("edge", "1 亮边"),
        ("body", "2 基础纹理"),
        ("mask", "3 抠除"),
        ("color", "4 颜色加深"),
    ]
    for column, (stage_id, title) in enumerate(stages):
        left = margin + column * (panel_width + margin)
        actual = reference.crop(EFFECT_CROPS[stage_id])
        actual_panel = fit_panel(actual, (panel_width, panel_height))
        sheet.paste(actual_panel, (left, header_height))
        draw.text((left, header_height + panel_height + 7), f"参考 {title}", fill="#ffd84d", font=font(16))

        rebuilt = render_stage(edge, body, shared, column + 1)
        rebuilt_panel = fit_panel(rebuilt, (panel_width, panel_height))
        second_top = header_height + panel_height + label_height + margin
        sheet.paste(rebuilt_panel, (left, second_top))
        draw.text((left, second_top + panel_height + 7), f"重建 {title}", fill="#7fe3ff", font=font(16))
    sheet.save(EFFECT_SHEET, optimize=True)


def head_detail_sheet(
    reference: Image.Image,
    edge: np.ndarray,
    body: np.ndarray,
    shared: np.ndarray,
) -> None:
    actual_stage = reference.crop(EFFECT_CROPS["body"])
    rebuilt_stage = render_stage(edge, body, shared, 2)
    crop_box = (50, 0, 180, 128)
    actual = actual_stage.crop(crop_box).resize((390, 384), Image.Resampling.LANCZOS)
    rebuilt = rebuilt_stage.crop(crop_box).resize((390, 384), Image.Resampling.LANCZOS)
    sheet = Image.new("RGB", (816, 438), "#11151b")
    draw = ImageDraw.Draw(sheet)
    sheet.paste(actual, (12, 42))
    sheet.paste(rebuilt, (414, 42))
    draw.text((12, 10), "参考：短而圆钝，白色向下分叉", fill="#ffd84d", font=font(18))
    draw.text((414, 10), "重建：限制径向长度，移除直切红条", fill="#7fe3ff", font=font(18))
    sheet.save(HEAD_DETAIL_SHEET, optimize=True)


def final_stage_sheet(
    reference: Image.Image,
    edge: np.ndarray,
    body: np.ndarray,
    shared: np.ndarray,
) -> None:
    actual = reference.crop(EFFECT_CROPS["color"]).crop((0, 0, 400, 325))
    rebuilt = render_stage(edge, body, shared, 4).crop((0, 0, 400, 325))
    actual_large = actual.resize((600, 488), Image.Resampling.LANCZOS)
    rebuilt_large = rebuilt.resize((600, 488), Image.Resampling.LANCZOS)
    sheet = Image.new("RGB", (1224, 536), "#11151b")
    draw = ImageDraw.Draw(sheet)
    sheet.paste(actual_large, (12, 40))
    sheet.paste(rebuilt_large, (612, 40))
    draw.text((12, 9), "参考：第四层终产物", fill="#ffd84d", font=font(19))
    draw.text((612, 9), "重建：第四层终产物", fill="#7fe3ff", font=font(19))
    sheet.save(FINAL_STAGE_SHEET, optimize=True)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", required=True, type=Path)
    args = parser.parse_args()
    reference = Image.open(args.reference).convert("RGB")
    if reference.size != (1280, 720):
        raise ValueError(f"expected 1280x720 reference, got {reference.size}")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    edge, body, shared = extract_textures(reference)
    save_textures(edge, body, shared)
    texture_sheet(edge, body, shared)
    effect_sheet(reference, edge, body, shared)
    head_detail_sheet(reference, edge, body, shared)
    final_stage_sheet(reference, edge, body, shared)
    for path in [
        EDGE_FILE,
        BODY_FILE,
        SHARED_FILE,
        SHARED_COPY_FILE,
        TEXTURE_SHEET,
        EFFECT_SHEET,
        HEAD_DETAIL_SHEET,
        FINAL_STAGE_SHEET,
    ]:
        with Image.open(path) as image:
            print(f"{path.name}\t{image.width}x{image.height}\t{sha256(path)}")


if __name__ == "__main__":
    main()
