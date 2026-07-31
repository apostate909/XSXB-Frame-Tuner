from __future__ import annotations

import hashlib
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


SIZE = 256
ROOT = Path(__file__).resolve().parents[1]
TEXTURE_OUTPUT = ROOT / "tools" / "animation_tuner" / "public" / "presets" / "attack_trails"
QA_OUTPUT = ROOT / "exports"

EDGE_NAME = "four_layer_fixed_edge_luma_v4.png"
BODY_NAME = "four_layer_fixed_body_luma_v4.png"
DETAIL_NAMES = {
    "liquid": "four_layer_shared_detail_liquid_v4.png",
    "ribbons": "four_layer_shared_detail_ribbons_v4.png",
    "eroded": "four_layer_shared_detail_eroded_v4.png",
}


def smoothstep(edge0: float, edge1: float, value: np.ndarray) -> np.ndarray:
    phase = np.clip((value - edge0) / max(1e-6, edge1 - edge0), 0.0, 1.0)
    return phase * phase * (3.0 - 2.0 * phase)


def to_luma_image(value: np.ndarray) -> Image.Image:
    pixels = np.clip(value * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(pixels, mode="L")


def from_luma_image(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("L"), dtype=np.float32) / 255.0


def triangle_mask(points: list[tuple[int, int]], blur_radius: float = 1.15) -> np.ndarray:
    source = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(source).polygon(points, fill=255)
    return from_luma_image(source.filter(ImageFilter.GaussianBlur(blur_radius)))


def registered_head_geometry() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    # These are two independent wedges, not one diagonal head triangle.
    # The horizontal wedge is the complete layer-1 image. The exact same
    # horizontal pixels are reused in layers 2/3/4.
    horizontal = triangle_mask([(0, 0), (244, 0), (0, 18)])
    # The vertical wedge exists only in layers 2/3/4. It starts at the same
    # upper-left registration point and tapers independently down the left edge.
    vertical = triangle_mask([(0, 0), (18, 0), (0, 238)])
    return horizontal, vertical, np.maximum(horizontal, vertical)


def build_fixed_body(x: np.ndarray, y: np.ndarray, complete_head: np.ndarray) -> np.ndarray:
    # The brush field stays deliberately below the head wedges' brightness so
    # the authored L head remains unmistakable in the raw source texture.
    tail_fade = 0.20 + 0.80 * np.power(1.0 - smoothstep(0.04, 0.99, x), 0.82)
    broad_flow = (
        0.48
        + 0.100 * np.sin(y * 17.0 * math.pi + x * 1.8)
        + 0.070 * np.sin(y * 39.0 * math.pi - x * 2.9)
        + 0.040 * np.sin(y * 73.0 * math.pi + x * 5.2)
    )
    brush_ridges = np.zeros_like(x)
    for base_y, width, amplitude, frequency, phase in [
        (0.08, 0.017, 0.016, 1.2, 0.3),
        (0.18, 0.021, 0.022, 1.5, 1.1),
        (0.31, 0.016, 0.017, 1.0, 2.0),
        (0.44, 0.024, 0.019, 1.4, 2.7),
        (0.57, 0.018, 0.021, 1.2, 3.4),
        (0.69, 0.023, 0.016, 1.6, 4.1),
        (0.82, 0.018, 0.020, 1.1, 4.8),
        (0.93, 0.015, 0.014, 1.4, 5.5),
    ]:
        center = base_y + amplitude * np.sin((x * frequency + phase) * 2.0 * math.pi)
        brush_ridges = np.maximum(brush_ridges, np.exp(-((y - center) / width) ** 2))
    body = tail_fade * np.clip(broad_flow + brush_ridges * 0.22, 0.0, 0.86)
    return np.maximum(body, complete_head)


def liquid_detail(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    detail = np.full_like(x, 0.28)
    rings = [
        (0.09, 0.10, 0.18, 0.060, 0.13),
        (0.34, 0.12, 0.23, 0.073, 0.14),
        (0.65, 0.11, 0.24, 0.068, 0.15),
        (0.87, 0.12, 0.18, 0.060, 0.13),
        (0.18, 0.36, 0.24, 0.085, 0.15),
        (0.52, 0.38, 0.25, 0.080, 0.15),
        (0.82, 0.37, 0.21, 0.073, 0.14),
        (0.08, 0.64, 0.18, 0.070, 0.13),
        (0.37, 0.65, 0.25, 0.083, 0.15),
        (0.70, 0.63, 0.26, 0.078, 0.15),
        (0.92, 0.65, 0.17, 0.065, 0.13),
        (0.22, 0.88, 0.24, 0.072, 0.14),
        (0.57, 0.87, 0.27, 0.078, 0.15),
        (0.88, 0.88, 0.20, 0.066, 0.13),
    ]
    for center_x, center_y, radius_x, radius_y, width in rings:
        warped_x = x + 0.026 * np.sin((y * 3.2 + center_x) * 2.0 * math.pi)
        warped_y = y + 0.018 * np.sin((x * 2.4 + center_y) * 2.0 * math.pi)
        distance = np.sqrt(
            ((warped_x - center_x) / radius_x) ** 2
            + ((warped_y - center_y) / radius_y) ** 2
        )
        ridge = np.exp(-((distance - 1.0) / width) ** 2)
        detail = np.maximum(detail, ridge)
    detail *= 0.94 - 0.20 * smoothstep(0.70, 1.0, x)
    return np.power(np.clip(detail, 0.0, 1.0), 0.78)


def ribbons_detail(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    detail = np.full_like(x, 0.24)
    for base_y, amplitude, frequency, phase, width in [
        (0.10, 0.025, 1.15, 0.2, 0.019),
        (0.25, 0.037, 1.40, 1.0, 0.023),
        (0.41, 0.030, 1.05, 1.9, 0.020),
        (0.58, 0.043, 1.28, 2.7, 0.024),
        (0.75, 0.031, 1.52, 3.5, 0.021),
        (0.90, 0.019, 1.20, 4.2, 0.018),
    ]:
        center = base_y + amplitude * np.sin((x * frequency + phase) * 2.0 * math.pi)
        ridge = np.exp(-((y - center) / width) ** 2)
        ridge *= 0.80 + 0.20 * np.sin((x * 3.1 + phase) * math.pi) ** 2
        detail = np.maximum(detail, ridge)
    detail *= 0.96 - 0.24 * smoothstep(0.70, 1.0, x)
    return np.power(np.clip(detail, 0.0, 1.0), 0.76)


def eroded_detail(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    rng = np.random.default_rng(20260729)
    coarse = Image.fromarray((rng.random((34, 18)) * 255).astype(np.uint8), mode="L")
    cloud = coarse.resize((SIZE, SIZE), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(4.2))
    cloud_array = from_luma_image(cloud)
    flow = (
        0.10 * np.sin(y * 9.0 * math.pi + x * 4.0)
        + 0.06 * np.sin(y * 19.0 * math.pi - x * 7.0)
    )
    islands = smoothstep(0.43, 0.62, cloud_array + flow)
    fine_channels = 0.5 + 0.5 * np.sin(y * 31.0 * math.pi + x * 3.0)
    detail = np.maximum(0.24, islands * (0.76 + 0.24 * fine_channels))
    detail *= 0.95 - 0.22 * smoothstep(0.68, 1.0, x)
    return np.clip(detail, 0.0, 1.0)


def build_textures() -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]:
    axis = np.linspace(0.0, 1.0, SIZE, dtype=np.float32)
    x, y = np.meshgrid(axis, axis)
    horizontal_head, _vertical_head, complete_head = registered_head_geometry()
    body = build_fixed_body(x, y, complete_head)
    variants = {
        "liquid": liquid_detail(x, y),
        "ribbons": ribbons_detail(x, y),
        "eroded": eroded_detail(x, y),
    }
    for variant_id in variants:
        # Layer 3 and layer 4 are the same saved image. Both carry the exact
        # horizontal layer-1 wedge and the same vertical head wedge as layer 2.
        variants[variant_id] = np.maximum(variants[variant_id], complete_head)
    return horizontal_head, body, variants


def save_luma(value: np.ndarray, name: str) -> Path:
    path = TEXTURE_OUTPUT / name
    to_luma_image(value).convert("RGB").save(path, optimize=True)
    return path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def labeled_contact_sheet(
    edge: np.ndarray,
    body: np.ndarray,
    variants: dict[str, np.ndarray],
) -> Path:
    margin = 16
    label_height = 54
    header_height = 54
    panel_stride = SIZE + margin
    row_stride = SIZE + label_height + margin
    sheet = Image.new(
        "RGB",
        (margin + panel_stride * 4, header_height + row_stride * len(variants) + margin),
        "#11141a",
    )
    draw = ImageDraw.Draw(sheet)
    draw.text(
        (margin, 16),
        "4 LOGICAL LAYERS / 3 PNG FILES  |  L3 == L4: SAME PATH + SAME HASH",
        fill="#fff2bb",
    )
    for row, (variant_id, detail) in enumerate(variants.items()):
        top = header_height + row * row_stride
        panels = [edge, body, detail, detail]
        labels = [
            "L1 FIXED EDGE\nhorizontal wedge only",
            "L2 FIXED BRUSH\nsame horizontal + vertical L",
            f"L3 {variant_id.upper()} MASK\nshared detail PNG",
            f"L4 {variant_id.upper()} COLOR\nsame shared detail PNG",
        ]
        for column, (panel, label) in enumerate(zip(panels, labels)):
            left = margin + column * panel_stride
            image = to_luma_image(panel).convert("RGB")
            sheet.paste(image, (left, top))
            draw.rectangle((left - 1, top - 1, left + SIZE, top + SIZE), outline="#65748a", width=1)
            first, second = label.split("\n", 1)
            draw.text((left, top + SIZE + 7), first, fill="#ffd54a")
            draw.text((left, top + SIZE + 24), second, fill="#c9d2e2")
        draw.text((margin, top + SIZE + 40), f"variant: {variant_id}", fill="#7fe3ff")
    path = QA_OUTPUT / "四层拖尾贴图预设_四层纹理结构对照.png"
    sheet.save(path, optimize=True)
    return path


def colorize(rgb: tuple[int, int, int], alpha: np.ndarray) -> Image.Image:
    output = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    for channel, value in enumerate(rgb):
        output[:, :, channel] = np.clip(value * alpha, 0, 255).astype(np.uint8)
    return Image.fromarray(output, mode="RGB")


def composite_preview(
    edge: np.ndarray,
    body: np.ndarray,
    detail: np.ndarray,
    variant_id: str,
) -> tuple[Image.Image, Image.Image, Image.Image, Image.Image]:
    background = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    base_tint = np.array([232.0, 236.0, 241.0], dtype=np.float32)
    inner_tint = np.array([220.0, 230.0, 240.0], dtype=np.float32)
    breakup_strength = 0.32
    inner_strength = 0.95

    body_alpha = body
    base_rgb = base_tint[None, None, :] * (0.44 + 0.5 * body[:, :, None])
    stage_body = background * (1.0 - body_alpha[:, :, None]) + base_rgb * body_alpha[:, :, None]

    breakup_alpha = 1.0 - breakup_strength * (1.0 - detail)
    cut_alpha = body * breakup_alpha
    stage_cut = background * (1.0 - cut_alpha[:, :, None]) + base_rgb * cut_alpha[:, :, None]

    streak_alpha = np.clip(detail * inner_strength, 0.0, 1.0)
    base_color = np.divide(
        stage_cut,
        np.maximum(cut_alpha[:, :, None], 1e-5),
        out=np.zeros_like(stage_cut),
        where=cut_alpha[:, :, None] > 1e-5,
    )
    screened = 255.0 - (255.0 - base_color) * (255.0 - inner_tint[None, None, :]) / 255.0
    final = stage_cut * (1.0 - streak_alpha[:, :, None]) + screened * streak_alpha[:, :, None]

    edge_image = to_luma_image(edge).filter(ImageFilter.GaussianBlur(8.0))
    glow = from_luma_image(edge_image) * 0.68
    final += np.array([255.0, 255.0, 255.0])[None, None, :] * glow[:, :, None]
    final += np.array([255.0, 255.0, 255.0])[None, None, :] * np.clip(edge * 1.15, 0.0, 1.0)[:, :, None]
    final = np.clip(final, 0.0, 255.0)

    edge_stage = colorize((255, 255, 255), np.clip(edge + glow * 0.65, 0.0, 1.0))
    body_stage = Image.fromarray(np.clip(stage_body, 0.0, 255.0).astype(np.uint8), mode="RGB")
    cut_stage = Image.fromarray(np.clip(stage_cut, 0.0, 255.0).astype(np.uint8), mode="RGB")
    final_stage = Image.fromarray(final.astype(np.uint8), mode="RGB")
    return edge_stage, body_stage, cut_stage, final_stage


def composite_contact_sheet(
    edge: np.ndarray,
    body: np.ndarray,
    variants: dict[str, np.ndarray],
) -> Path:
    margin = 16
    label_height = 40
    header_height = 54
    panel_stride = SIZE + margin
    row_stride = SIZE + label_height + margin
    sheet = Image.new(
        "RGB",
        (margin + panel_stride * 4, header_height + row_stride * len(variants) + margin),
        "#11141a",
    )
    draw = ImageDraw.Draw(sheet)
    draw.text((margin, 16), "FUNCTIONAL COMPOSITE QA  |  fixed edge/body, variant shared detail only", fill="#fff2bb")
    labels = ["1 EDGE / GLOW", "2 FIXED BRUSH", "3 AFTER MASK", "4 INNER COLOR + EDGE"]
    for row, (variant_id, detail) in enumerate(variants.items()):
        top = header_height + row * row_stride
        panels = composite_preview(edge, body, detail, variant_id)
        for column, (panel, label) in enumerate(zip(panels, labels)):
            left = margin + column * panel_stride
            sheet.paste(panel, (left, top))
            draw.rectangle((left - 1, top - 1, left + SIZE, top + SIZE), outline="#65748a", width=1)
            draw.text((left, top + SIZE + 7), label, fill="#ffd54a")
        draw.text((margin, top + SIZE + 23), f"variant: {variant_id}", fill="#7fe3ff")
    path = QA_OUTPUT / "四层拖尾贴图预设_功能合成效果对照.png"
    sheet.save(path, optimize=True)
    return path


def verify_geometry(
    edge: np.ndarray,
    body: np.ndarray,
    variants: dict[str, np.ndarray],
) -> None:
    horizontal, vertical, _complete = registered_head_geometry()
    # Layer 1 contains no independently authored vertical wedge.
    assert float(edge[96:, :12].max()) < 0.05
    # The fixed body and every shared detail map contain both bright wedges.
    horizontal_probe = horizontal > 0.92
    vertical_probe = vertical > 0.92
    assert np.all(body[horizontal_probe] > 0.92)
    assert np.all(body[vertical_probe] > 0.92)
    for detail in variants.values():
        assert np.all(detail[horizontal_probe] > 0.92)
        assert np.all(detail[vertical_probe] > 0.92)


def main() -> None:
    TEXTURE_OUTPUT.mkdir(parents=True, exist_ok=True)
    QA_OUTPUT.mkdir(parents=True, exist_ok=True)
    edge, body, variants = build_textures()
    verify_geometry(edge, body, variants)

    paths = [
        save_luma(edge, EDGE_NAME),
        save_luma(body, BODY_NAME),
        *[save_luma(variants[variant_id], DETAIL_NAMES[variant_id]) for variant_id in DETAIL_NAMES],
    ]
    structure_path = labeled_contact_sheet(edge, body, variants)
    composite_path = composite_contact_sheet(edge, body, variants)

    for path in paths:
        with Image.open(path) as image:
            assert image.size == (SIZE, SIZE)
        print(f"{path.name} {sha256(path)}")
    print(structure_path)
    print(composite_path)


if __name__ == "__main__":
    main()
