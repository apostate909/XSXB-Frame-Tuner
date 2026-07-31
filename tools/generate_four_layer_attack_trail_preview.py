from __future__ import annotations

import hashlib
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


SIZE = 256
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "exports" / "四层拖尾贴图预览_待确认"
DEFAULT_TEXTURE_ROOT = (
    ROOT / "tools" / "animation_tuner" / "public" / "presets" / "attack_trails"
)

EDGE_FILE = OUTPUT / "01_固定亮边.png"
BODY_FILE = OUTPUT / "02_固定基础纹理.png"
SHARED_FILE = OUTPUT / "03与04_共用抠除及补色纹理.png"
STRUCTURE_FILE = OUTPUT / "四层贴图结构对照_待确认.png"
COMPOSITE_FILE = OUTPUT / "四层功能合成对照_待确认.png"


def smoothstep(edge0: float, edge1: float, value: np.ndarray) -> np.ndarray:
    phase = np.clip((value - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return phase * phase * (3.0 - 2.0 * phase)


def to_luma(value: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(value * 255.0, 0, 255).astype(np.uint8), "L")


def from_luma(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("L"), dtype=np.float32) / 255.0


def triangle(points: list[tuple[int, int]], blur: float = 0.65) -> np.ndarray:
    source = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(source).polygon(points, fill=255)
    if blur > 0:
        source = source.filter(ImageFilter.GaussianBlur(blur))
    return from_luma(source)


def registered_head() -> tuple[np.ndarray, np.ndarray]:
    horizontal = triangle([(0, 0), (251, 0), (0, 17)])
    vertical = triangle([(0, 0), (17, 0), (0, 242)])
    return horizontal, np.maximum(horizontal, vertical)


def fixed_brush(x: np.ndarray, y: np.ndarray, full_head: np.ndarray) -> np.ndarray:
    tail = np.power(np.clip(1.0 - x, 0.0, 1.0), 0.62)
    left_energy = 0.16 + 0.84 * tail

    fine = (
        0.52
        + 0.18 * np.sin(y * 52.0 * math.pi + x * 5.0)
        + 0.10 * np.sin(y * 91.0 * math.pi - x * 8.0)
        + 0.06 * np.sin(y * 143.0 * math.pi + x * 11.0)
    )
    broad = (
        0.58
        + 0.13 * np.sin(y * 15.0 * math.pi + x * 2.2)
        + 0.08 * np.sin(y * 27.0 * math.pi - x * 3.1)
    )

    ridges = np.zeros_like(x)
    for row, amplitude, frequency, phase, width in [
        (0.08, 0.016, 1.4, 0.2, 0.010),
        (0.16, 0.022, 1.1, 1.0, 0.012),
        (0.27, 0.018, 1.6, 1.8, 0.011),
        (0.38, 0.026, 1.2, 2.6, 0.014),
        (0.50, 0.020, 1.5, 3.2, 0.011),
        (0.61, 0.028, 1.0, 4.0, 0.014),
        (0.73, 0.020, 1.7, 4.7, 0.011),
        (0.84, 0.024, 1.3, 5.4, 0.013),
        (0.94, 0.014, 1.6, 6.1, 0.009),
    ]:
        center = row + amplitude * np.sin((x * frequency + phase) * 2.0 * math.pi)
        ridges = np.maximum(ridges, np.exp(-((y - center) / width) ** 2))

    brush = left_energy * np.clip(0.12 + fine * 0.25 + broad * 0.20 + ridges * 0.34, 0.0, 0.88)
    brush *= 1.0 - 0.54 * smoothstep(0.70, 1.0, x)
    return np.maximum(brush, full_head)


def shared_flow_detail(x: np.ndarray, y: np.ndarray, full_head: np.ndarray) -> np.ndarray:
    # Build a sparse field of hand-positioned, noise-warped liquid loops like
    # the reference map. There is deliberately no raised gray floor.
    rng = np.random.default_rng(2026072904)
    noise_x = Image.fromarray((rng.random((12, 8)) * 255).astype(np.uint8), "L")
    noise_y = Image.fromarray((rng.random((11, 9)) * 255).astype(np.uint8), "L")
    warp_x = from_luma(
        noise_x.resize((SIZE, SIZE), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(7.0))
    ) - 0.5
    warp_y = from_luma(
        noise_y.resize((SIZE, SIZE), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(7.0))
    ) - 0.5
    warped_x = x + warp_x * 0.075 + 0.018 * np.sin(y * 9.0 * math.pi)
    warped_y = y + warp_y * 0.050 + 0.012 * np.sin(x * 6.0 * math.pi)

    detail = np.zeros_like(x)
    rows = [
        (0.10, [(-0.07, 0.23), (0.25, 0.25), (0.59, 0.27), (0.94, 0.24)]),
        (0.35, [(0.08, 0.24), (0.42, 0.28), (0.80, 0.27), (1.13, 0.23)]),
        (0.61, [(-0.10, 0.22), (0.23, 0.27), (0.59, 0.29), (0.96, 0.25)]),
        (0.87, [(0.06, 0.24), (0.40, 0.27), (0.76, 0.29), (1.11, 0.23)]),
    ]
    for row_index, (center_y, loops) in enumerate(rows):
        for loop_index, (center_x, radius_x) in enumerate(loops):
            phase = row_index * 1.73 + loop_index * 0.91
            radius_y = 0.074 + 0.010 * math.sin(phase * 1.4)
            dx = (warped_x - center_x) / radius_x
            dy = (warped_y - center_y) / radius_y
            angle = np.arctan2(dy, dx)
            distance = np.sqrt(dx * dx + dy * dy)
            irregular = distance / (
                1.0
                + 0.075 * np.sin(angle * 3.0 + phase)
                + 0.045 * np.sin(angle * 5.0 - phase * 0.6)
            )
            outer = np.exp(-((irregular - 1.0) / 0.155) ** 2)
            inner_gate = smoothstep(-0.25, 0.45, np.sin(angle * 1.7 + phase))
            inner = np.exp(-((irregular - 0.70) / 0.130) ** 2) * inner_gate * 0.42
            detail = np.maximum(detail, np.maximum(outer, inner))

    # Sparse broken filaments link some neighboring loops without filling the
    # black gaps that layer 3 needs for decisive removal.
    for row, amplitude, frequency, phase, width in [
        (0.22, 0.028, 1.1, 0.4, 0.010),
        (0.48, 0.036, 0.9, 2.0, 0.011),
        (0.74, 0.030, 1.3, 3.7, 0.010),
    ]:
        center = row + amplitude * np.sin((x * frequency + phase) * 2.0 * math.pi)
        filament = np.exp(-((warped_y - center) / width) ** 2)
        broken = smoothstep(0.42, 0.86, 0.5 + 0.5 * np.sin(x * 11.0 + phase))
        detail = np.maximum(detail, filament * broken * 0.74)

    detail *= 1.0 - 0.46 * smoothstep(0.72, 1.0, x)
    detail = from_luma(to_luma(detail).filter(ImageFilter.GaussianBlur(1.7)))
    detail = smoothstep(0.025, 0.60, detail)
    return np.maximum(detail, full_head)


def build_textures() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    edge, full_head = registered_head()
    body = from_luma(Image.open(DEFAULT_TEXTURE_ROOT / "coherent_trail_body_luma.png"))
    shared = from_luma(Image.open(DEFAULT_TEXTURE_ROOT / "coherent_breakup_luma.png"))

    # Keep the default preset's dense brush coverage and soft breakup flow, but
    # replace its diagonal head construction with the confirmed registered L.
    yy, xx = np.indices((SIZE, SIZE), dtype=np.float32)
    corner_weight = (
        1.0 - smoothstep(34.0, 94.0, xx)
    ) * (
        1.0 - smoothstep(34.0, 94.0, yy)
    )
    shifted_x = np.clip(xx.astype(np.int32) + 84, 0, SIZE - 1)
    source_y = yy.astype(np.int32)
    body_corner = body[source_y, shifted_x]
    body = body * (1.0 - corner_weight) + body_corner * corner_weight
    body = np.maximum(body, full_head)

    # Remove the default diagonal white head from the shared map before adding
    # the exact horizontal and vertical wedges.
    shared_corner = shared[source_y, shifted_x]
    shared = shared * (1.0 - corner_weight) + shared_corner * corner_weight
    shared = np.maximum(shared, full_head)
    return edge, body, shared


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in [
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
    ]:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def save_texture(path: Path, value: np.ndarray) -> None:
    to_luma(value).convert("RGB").save(path, optimize=True)


def texture_structure_sheet(edge: np.ndarray, body: np.ndarray, shared: np.ndarray) -> None:
    width, height = 1228, 382
    sheet = Image.new("RGB", (width, height), "#11151b")
    draw = ImageDraw.Draw(sheet)
    draw.text((24, 16), "四层逻辑 / 三张贴图（第3层与第4层为同一个文件）", fill="#f6df8b", font=font(24))
    panels = [
        (edge, "1  固定亮边", "仅上边横向楔形"),
        (body, "2  固定基础纹理", "按默认组：亮度控制主体与明暗"),
        (shared, "3  抠除", "同图0.72强度：黑弱、白保留"),
        (shared, "4  纹路补色", "同一张图screen叠加粉色亮纹"),
    ]
    for index, (value, title, subtitle) in enumerate(panels):
        left = 24 + index * 300
        top = 64
        sheet.paste(to_luma(value).convert("RGB"), (left, top))
        draw.rectangle((left - 1, top - 1, left + SIZE, top + SIZE), outline="#6d7c90", width=1)
        draw.text((left, 328), title, fill="#ffd84d", font=font(18))
        draw.text((left, 354), subtitle, fill="#c8d2df", font=font(14))
    sheet.save(STRUCTURE_FILE, optimize=True)


def warp_to_arc(texture: np.ndarray, canvas_size: int = 512) -> np.ndarray:
    yy, xx = np.indices((canvas_size, canvas_size), dtype=np.float32)
    center_x, center_y = 264.0, 246.0
    dx = xx - center_x
    dy = center_y - yy
    radius = np.sqrt(dx * dx + dy * dy)
    angle = np.degrees(np.arctan2(dy, dx))
    angle = np.where(angle < 0.0, angle + 360.0, angle)

    start, end = 132.0, 330.0
    u = (angle - start) / (end - start)
    outer_radius, band_width = 205.0, 92.0
    v = (outer_radius - radius) / band_width
    valid = (u >= 0.0) & (u <= 1.0) & (v >= 0.0) & (v <= 1.0)

    source_x = np.clip(np.rint(u * (SIZE - 1)), 0, SIZE - 1).astype(np.int32)
    source_y = np.clip(np.rint(v * (SIZE - 1)), 0, SIZE - 1).astype(np.int32)
    result = np.zeros((canvas_size, canvas_size), dtype=np.float32)
    result[valid] = texture[source_y[valid], source_x[valid]]
    return result


def grid_background(size: int = 512) -> Image.Image:
    image = Image.new("RGB", (size, size), "#20242a")
    draw = ImageDraw.Draw(image)
    for position in range(0, size + 1, 64):
        draw.line((position, 0, position, size), fill="#394047", width=1)
        draw.line((0, position, size, position), fill="#394047", width=1)
    return image


def alpha_over(base: np.ndarray, color: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    return base * (1.0 - alpha[:, :, None]) + color * alpha[:, :, None]


def render_arc_stage(
    edge: np.ndarray,
    body: np.ndarray,
    shared: np.ndarray,
    stage: int,
) -> Image.Image:
    edge_arc = warp_to_arc(edge)
    body_arc = warp_to_arc(body)
    shared_arc = warp_to_arc(shared)
    axis = np.linspace(0.0, 1.0, SIZE, dtype=np.float32)
    carrier_u, carrier_v = np.meshgrid(axis, axis)
    tail_fade = 1.0 - smoothstep(0.63, 1.0, carrier_u)
    width_fade = smoothstep(0.0, 0.035, carrier_v) * (
        1.0 - smoothstep(0.94, 1.0, carrier_v)
    )
    carrier_arc = warp_to_arc(tail_fade * width_fade)
    base = np.asarray(grid_background(), dtype=np.float32)
    body_tint = np.array([217.0, 54.0, 74.0])[None, None, :]
    body_detail = 0.44 + 0.50 * body_arc
    mapped_body_color = body_tint * body_detail[:, :, None]

    if stage == 1:
        visible = edge_arc
        body_color = np.full((512, 512, 3), 255.0, dtype=np.float32)
    elif stage == 2:
        visible = carrier_arc * body_arc
        body_color = mapped_body_color
    else:
        # Match the default preset's breakup equation exactly: black retains
        # 28 percent while white retains the full body.
        shared_visibility = np.clip(shared_arc, 0.0, 1.0)
        breakup_alpha = 1.0 - 0.72 * (1.0 - shared_visibility)
        visible = carrier_arc * body_arc * breakup_alpha
        body_color = mapped_body_color
        if stage == 4:
            # Match the default preset: the same breakup texture also screens
            # pink streaks back over the retained body at strength 0.46.
            streak_color = np.array([233.0, 63.0, 115.0])[None, None, :]
            screened = 255.0 - (
                (255.0 - body_color) * (255.0 - streak_color) / 255.0
            )
            streak_alpha = np.clip(shared_visibility * 0.46, 0.0, 1.0)[:, :, None]
            body_color = body_color * (1.0 - streak_alpha) + screened * streak_alpha

    result = alpha_over(base, body_color, np.clip(visible * 0.94, 0.0, 1.0))

    glow_mask = from_luma(
        to_luma(edge_arc).filter(ImageFilter.GaussianBlur(15.0))
    )
    pink_glow = np.array([255.0, 25.0, 112.0])[None, None, :]
    result += pink_glow * np.clip(glow_mask * 0.50, 0.0, 1.0)[:, :, None]

    if stage >= 2:
        result = alpha_over(
            result,
            np.full((512, 512, 3), 255.0, dtype=np.float32),
            np.clip(edge_arc * 0.98, 0.0, 1.0),
        )
    elif stage == 1:
        result = alpha_over(
            result,
            np.full((512, 512, 3), 255.0, dtype=np.float32),
            np.clip(edge_arc, 0.0, 1.0),
        )
    return Image.fromarray(np.clip(result, 0.0, 255.0).astype(np.uint8), "RGB")


def composite_sheet(edge: np.ndarray, body: np.ndarray, shared: np.ndarray) -> None:
    panel_size = 330
    margin = 20
    header = 58
    footer = 64
    sheet = Image.new(
        "RGB",
        (margin + (panel_size + margin) * 4, header + panel_size + footer),
        "#11151b",
    )
    draw = ImageDraw.Draw(sheet)
    draw.text((20, 15), "四层功能合成预览（第3/4层严格共用同一纹理）", fill="#f6df8b", font=font(24))
    titles = [
        ("1 亮边", "锐利外缘与荧光源"),
        ("2 基础纹理", "按默认组：纹理亮度控制主体显隐"),
        ("3 抠除", "同图0.72强度，保留连续红色底"),
        ("4 纹路补色", "同一纹理screen补回粉色亮纹"),
    ]
    for index, (title, subtitle) in enumerate(titles):
        panel = render_arc_stage(edge, body, shared, index + 1)
        panel = panel.resize((panel_size, panel_size), Image.Resampling.LANCZOS)
        left = margin + index * (panel_size + margin)
        sheet.paste(panel, (left, header))
        draw.rectangle((left - 1, header - 1, left + panel_size, header + panel_size), outline="#6d7c90")
        draw.text((left, header + panel_size + 10), title, fill="#ffd84d", font=font(18))
        draw.text((left, header + panel_size + 36), subtitle, fill="#c8d2df", font=font(14))
    sheet.save(COMPOSITE_FILE, optimize=True)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    edge, body, shared = build_textures()
    save_texture(EDGE_FILE, edge)
    save_texture(BODY_FILE, body)
    save_texture(SHARED_FILE, shared)
    texture_structure_sheet(edge, body, shared)
    composite_sheet(edge, body, shared)

    for path in [EDGE_FILE, BODY_FILE, SHARED_FILE, STRUCTURE_FILE, COMPOSITE_FILE]:
        with Image.open(path) as image:
            print(f"{path.name}\t{image.width}x{image.height}\t{sha256(path)}")


if __name__ == "__main__":
    main()
