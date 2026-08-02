"""Generate miterm app icon: thicker 3D ring + embossed ice-blue M, tight crop."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "miterm_no_bg.png"
OUT_DESIGN = ROOT / "miterm_icon_3d.png"
OUT_SOURCE = ROOT / "miterm-icon-source.png"


def content_mask(rgba: np.ndarray) -> np.ndarray:
    a = rgba[:, :, 3]
    r, g, b = rgba[:, :, 0], rgba[:, :, 1], rgba[:, :, 2]
    return (a >= 16) & ~((r <= 18) & (g <= 18) & (b <= 18))


def bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def extract_center(src: Image.Image, inner_r: float) -> Image.Image:
    rgba = np.array(src.convert("RGBA"))
    h, w = rgba.shape[:2]
    mask = content_mask(rgba)
    x0, y0, x1, y1 = bbox(mask)
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    yy, xx = np.ogrid[:h, :w]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    keep = dist <= inner_r
    out = np.zeros_like(rgba)
    out[keep] = rgba[keep]
    return Image.fromarray(out, "RGBA")


def _shade_ramp(
    shade: np.ndarray,
    lo: np.ndarray,
    mid: np.ndarray,
    hi: np.ndarray,
    split: float = 0.42,
) -> np.ndarray:
    """Map 0..1 shade to RGB via lo->mid->hi."""
    s = np.clip(shade, 0, 1)
    out = np.zeros(s.shape + (3,), dtype=np.float32)
    low = s <= split
    t_low = np.zeros_like(s)
    t_hi = np.zeros_like(s)
    t_low[low] = s[low] / split
    t_hi[~low] = (s[~low] - split) / (1.0 - split)
    for i in range(3):
        out[:, :, i] = np.where(
            low,
            lo[i] * (1 - t_low) + mid[i] * t_low,
            mid[i] * (1 - t_hi) + hi[i] * t_hi,
        )
    return out


def style_center_glyph(img: Image.Image) -> Image.Image:
    """Stronger embossed ice-blue M + lit progress bar."""
    rgba = np.array(img.convert("RGBA"), dtype=np.float32)
    h, w = rgba.shape[:2]
    a = rgba[:, :, 3]
    r, g, b = rgba[:, :, 0], rgba[:, :, 1], rgba[:, :, 2]
    lum = (r + g + b) / 3.0
    visible = a >= 16
    is_white = visible & (lum >= 200) & (np.abs(r - g) < 40) & (np.abs(g - b) < 40)
    is_bar = visible & ~is_white

    if not is_white.any():
        return img

    yy, xx = np.ogrid[:h, :w]
    ys, xs = np.where(is_white)
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    ny = (yy - y0) / max(1, (y1 - y0))
    nx = (xx - x0) / max(1, (x1 - x0))

    # Global key light (top-left)
    shade = 0.32 + 0.68 * (0.72 * (1.0 - ny) + 0.28 * (1.0 - nx))
    shade = np.clip(shade, 0.18, 1.0)

    # Edge emboss: brighter on light-facing stroke edges
    glyph = (is_white & (a > 128)).astype(np.uint8) * 255
    g_img = Image.fromarray(glyph, mode="L")
    blur = np.array(g_img.filter(ImageFilter.GaussianBlur(2.2)), dtype=np.float32) / 255.0
    # Approximate height field; light from (-1,-1)
    gy = np.zeros_like(blur)
    gx = np.zeros_like(blur)
    gy[1:-1, :] = blur[2:, :] - blur[:-2, :]
    gx[:, 1:-1] = blur[:, 2:] - blur[:, :-2]
    emboss = np.clip((-gx - gy) * 2.8 + 0.55, 0.2, 1.35)
    shade = np.clip(shade * 0.55 + emboss * 0.55, 0.15, 1.0)

    ice_hi = np.array([255, 255, 255], dtype=np.float32)
    ice_mid = np.array([170, 225, 255], dtype=np.float32)
    ice_lo = np.array([45, 120, 210], dtype=np.float32)
    rgb_m = _shade_ramp(shade, ice_lo, ice_mid, ice_hi, split=0.38)

    # Specular hot-spot upper-left
    spec = np.exp(-(((ny - 0.10) / 0.22) ** 2)) * np.exp(-(((nx - 0.22) / 0.38) ** 2))
    spec = np.clip(spec * 0.72, 0, 1)
    for i in range(3):
        rgb_m[:, :, i] = np.clip(rgb_m[:, :, i] + spec * (255 - rgb_m[:, :, i]), 0, 255)

    letter = np.zeros_like(rgba)
    letter[:, :, :3] = rgb_m
    letter[:, :, 3] = np.where(is_white, a, 0)

    # Dual outline: dark outer + bright inner lip
    dil = np.array(g_img.filter(ImageFilter.MaxFilter(7)), dtype=np.float32)
    mid = np.array(g_img.filter(ImageFilter.MaxFilter(3)), dtype=np.float32)
    ero = np.array(g_img.filter(ImageFilter.MinFilter(3)), dtype=np.float32)
    outer_ring = (dil > 128) & (mid < 128)
    inner_lip = (mid > 128) & (ero < 128) & is_white
    outline = np.zeros_like(rgba)
    outline[outer_ring] = (12, 50, 110, 240)
    lip = np.zeros_like(rgba)
    lip[inner_lip] = (230, 248, 255, 160)

    # Contact + cast shadow
    shadow = Image.fromarray(
        np.where(is_white, np.clip(a, 0, 255).astype(np.uint8), 0), mode="L"
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(5))
    sh = np.array(shadow, dtype=np.float32)
    shadow_rgba = np.zeros_like(rgba)
    ox, oy = 6, 9
    sh_pad = np.zeros_like(sh)
    sh_pad[oy:, ox:] = sh[:-oy, :-ox]
    shadow_rgba[:, :, 1] = 18
    shadow_rgba[:, :, 2] = 55
    shadow_rgba[:, :, 3] = np.clip(sh_pad * 0.85, 0, 220)

    # Progress bar with top-edge highlight
    bar = np.zeros_like(rgba)
    if is_bar.any():
        bys, bxs = np.where(is_bar)
        b_y0, b_y1 = bys.min(), bys.max()
        b_ny = (yy - b_y0) / max(1, (b_y1 - b_y0))
        bar_shade = np.clip(0.55 + 0.45 * (1.0 - b_ny), 0.4, 1.0)
        cyan_lo = np.array([40, 140, 210], dtype=np.float32)
        cyan_hi = np.array([180, 245, 255], dtype=np.float32)
        base_rgb = np.stack([r, g, b], axis=-1)
        tinted = base_rgb * 0.45 + np.array([100, 210, 255], dtype=np.float32) * 0.55
        for i in range(3):
            bar[:, :, i] = np.clip(
                tinted[:, :, i] * bar_shade
                + (cyan_hi[i] - cyan_lo[i]) * np.maximum(0, 0.35 - b_ny) * 0.8,
                0,
                255,
            )
        bar[:, :, 3] = np.where(is_bar, a, 0)

    layers = [
        Image.fromarray(shadow_rgba.astype(np.uint8), "RGBA"),
        Image.fromarray(outline.astype(np.uint8), "RGBA"),
        Image.fromarray(letter.astype(np.uint8), "RGBA"),
        Image.fromarray(lip.astype(np.uint8), "RGBA"),
        Image.fromarray(bar.astype(np.uint8), "RGBA"),
    ]
    base = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for layer in layers:
        base = Image.alpha_composite(base, layer)
    return base


def draw_thick_ring_3d(
    size: int,
    cx: float,
    cy: float,
    r_outer: float,
    r_inner: float,
) -> Image.Image:
    """Stronger torus shading + specular + contact lips."""
    yy, xx = np.ogrid[:size, :size]
    dx = xx - cx
    dy = yy - cy
    dist = np.sqrt(dx * dx + dy * dy)
    band = (dist >= r_inner) & (dist <= r_outer)

    t = (dist - r_inner) / max(1e-6, (r_outer - r_inner))
    # Peak slightly outside mid for chunkier tube
    radial = np.sin(np.pi * np.clip(t, 0, 1)) ** 0.70

    ang = np.arctan2(dy, dx)
    angular = 0.38 + 0.62 * np.cos(ang - math.pi * 0.75)
    angular = np.clip(angular, 0.12, 1.0)

    shade = np.clip(0.18 + 0.82 * radial * angular, 0, 1)

    highlight = np.array([230, 250, 255], dtype=np.float32)
    mid = np.array([50, 155, 250], dtype=np.float32)
    shadow = np.array([8, 35, 100], dtype=np.float32)
    rgb = _shade_ramp(shade, shadow, mid, highlight, split=0.40)

    # Outer specular ridge (lit side)
    rim = np.exp(-(((t - 0.78) / 0.10) ** 2)) * np.clip((angular - 0.50) * 2.4, 0, 1)
    for i in range(3):
        rgb[:, :, i] = np.clip(rgb[:, :, i] + rim * (255 - rgb[:, :, i]) * 0.70, 0, 255)

    # Secondary gloss near top
    gloss = np.exp(-(((t - 0.55) / 0.18) ** 2)) * np.clip((angular - 0.62) * 1.8, 0, 1)
    for i in range(3):
        rgb[:, :, i] = np.clip(rgb[:, :, i] + gloss * (255 - rgb[:, :, i]) * 0.35, 0, 255)

    # Inner / outer lips darker for depth
    inner_lip = np.exp(-(((t - 0.06) / 0.09) ** 2)) * 0.55
    outer_lip = np.exp(-(((t - 0.96) / 0.08) ** 2)) * 0.40
    for i in range(3):
        rgb[:, :, i] *= 1.0 - inner_lip
        rgb[:, :, i] *= 1.0 - outer_lip * 0.7

    col = np.zeros((size, size, 4), dtype=np.uint8)
    col[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    col[:, :, 3] = np.where(band, 255, 0).astype(np.uint8)

    img = Image.fromarray(col, "RGBA")
    edge = Image.fromarray(
        np.where(band, 255, 0).astype(np.uint8), mode="L"
    ).filter(ImageFilter.GaussianBlur(0.9))
    arr = np.array(img)
    arr[:, :, 3] = np.minimum(arr[:, :, 3], np.array(edge))
    return Image.fromarray(arr, "RGBA")


def draw_segment_accents(
    size: int,
    cx: float,
    cy: float,
    r: float,
    half_w: float,
) -> Image.Image:
    """Raised glowing chips with simple bevel."""
    yy, xx = np.ogrid[:size, :size]
    dx = xx - cx
    dy = yy - cy
    dist = np.sqrt(dx * dx + dy * dy)
    ang = (np.degrees(np.arctan2(dy, dx)) + 360) % 360
    band = (dist >= r - half_w) & (dist <= r + half_w)

    span = 16
    centers = [0, 90, 180, 270]
    chip = np.zeros(dist.shape, dtype=bool)
    for c in centers:
        d = np.minimum(np.abs(ang - c), 360 - np.abs(ang - c))
        chip |= d <= span

    mask = band & chip
    # Bevel along radial thickness
    t = (dist - (r - half_w)) / max(1e-6, 2 * half_w)
    bevel = np.sin(np.pi * np.clip(t, 0, 1)) ** 0.8
    angular = 0.45 + 0.55 * np.cos(np.arctan2(dy, dx) - math.pi * 0.75)
    shade = np.clip(0.35 + 0.65 * bevel * np.clip(angular, 0.2, 1), 0, 1)

    lo = np.array([40, 130, 210], dtype=np.float32)
    hi = np.array([210, 250, 255], dtype=np.float32)
    col = np.zeros((size, size, 4), dtype=np.float32)
    for i in range(3):
        col[:, :, i] = lo[i] * (1 - shade) + hi[i] * shade
    col[:, :, 3] = np.where(mask, 245, 0)
    img = Image.fromarray(np.clip(col, 0, 255).astype(np.uint8), "RGBA")
    return img.filter(ImageFilter.GaussianBlur(0.5))


def inner_disc(size: int, cx: float, cy: float, r: float) -> Image.Image:
    """Dark disc with edge ambient occlusion under the ring."""
    yy, xx = np.ogrid[:size, :size]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    inside = dist <= r
    # Slightly brighter center, darker near rim (AO)
    t = np.clip(dist / max(1e-6, r), 0, 1)
    ao = 0.12 + 0.55 * (t**1.6)
    col = np.zeros((size, size, 4), dtype=np.float32)
    # deep blue-black
    col[:, :, 0] = 4
    col[:, :, 1] = 10
    col[:, :, 2] = 22
    col[:, :, 3] = np.where(inside, np.clip(ao * 255, 0, 230), 0)
    # soft vignette blur on alpha edge
    img = Image.fromarray(col.astype(np.uint8), "RGBA")
    return img


def ring_contact_shadow(
    size: int, cx: float, cy: float, r_inner: float
) -> Image.Image:
    """Soft shadow cast inward from the ring onto the disc."""
    yy, xx = np.ogrid[:size, :size]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    # band just inside inner radius
    fall = np.clip(1.0 - (r_inner - dist) / (r_inner * 0.14), 0, 1)
    band = (dist < r_inner) & (dist > r_inner * 0.78)
    col = np.zeros((size, size, 4), dtype=np.float32)
    col[:, :, 2] = 40
    col[:, :, 3] = np.where(band, fall**1.4 * 140, 0)
    return Image.fromarray(col.astype(np.uint8), "RGBA").filter(
        ImageFilter.GaussianBlur(3)
    )


def compose(size: int = 1400) -> Image.Image:
    src = Image.open(SRC).convert("RGBA")
    rgba = np.array(src)
    mask = content_mask(rgba)
    x0, y0, x1, y1 = bbox(mask)
    half = max(x1 - x0, y1 - y0) / 2
    inner_r = half * 0.50
    center_img = extract_center(src, inner_r)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = cy = size / 2

    r_out = size * 0.498
    r_in = r_out * 0.64

    # Outer glow (stronger, layered)
    yy, xx = np.ogrid[:size, :size]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    glow = np.zeros((size, size, 4), dtype=np.float32)
    halo = np.clip(1.0 - np.abs(dist - (r_out + 4)) / 22.0, 0, 1) ** 1.6
    glow[:, :, 0] = 50
    glow[:, :, 1] = 150
    glow[:, :, 2] = 255
    glow[:, :, 3] = halo * 110
    canvas = Image.alpha_composite(
        canvas,
        Image.fromarray(glow.astype(np.uint8), "RGBA").filter(
            ImageFilter.GaussianBlur(10)
        ),
    )

    # Inner disc + AO before ring so ring sits on top
    canvas = Image.alpha_composite(canvas, inner_disc(size, cx, cy, r_in * 0.995))
    canvas = Image.alpha_composite(canvas, ring_contact_shadow(size, cx, cy, r_in))

    ring = draw_thick_ring_3d(size, cx, cy, r_out, r_in)
    canvas = Image.alpha_composite(canvas, ring)

    accents = draw_segment_accents(
        size, cx, cy, (r_out + r_in) / 2, half_w=(r_out - r_in) * 0.20
    )
    canvas = Image.alpha_composite(canvas, accents)

    # Center glyph
    c_rgba = np.array(center_img)
    c_mask = content_mask(c_rgba)
    if c_mask.any():
        bx0, by0, bx1, by1 = bbox(c_mask)
        center_img = center_img.crop((bx0, by0, bx1 + 1, by1 + 1))
    center_img = style_center_glyph(center_img)
    target_d = r_in * 2 * 0.88
    scale = target_d / max(center_img.size)
    new_w = max(1, int(center_img.width * scale))
    new_h = max(1, int(center_img.height * scale))
    center_img = center_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    px = int(cx - new_w / 2)
    py = int(cy - new_h / 2 - size * 0.01)
    canvas.alpha_composite(center_img, (px, py))
    return canvas


def crop_tight(img: Image.Image, pad_ratio: float = 0.01) -> Image.Image:
    rgba = np.array(img)
    mask = content_mask(rgba)
    x0, y0, x1, y1 = bbox(mask)
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    side = max(cw, ch)
    pad = max(1, int(math.ceil(side * pad_ratio)))
    side = side + 2 * pad
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    left = int(round(cx - side / 2))
    top = int(round(cy - side / 2))
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(img, (-left, -top), img)
    return out


def main() -> None:
    design = compose(1400)
    design.save(OUT_DESIGN)
    cropped = crop_tight(design, pad_ratio=0.01)
    final = cropped.resize((1024, 1024), Image.Resampling.LANCZOS)
    final.save(OUT_SOURCE)
    print(f"wrote {OUT_DESIGN}")
    print(f"wrote {OUT_SOURCE}")
    rgba = np.array(final)
    m = content_mask(rgba)
    x0, y0, x1, y1 = bbox(m)
    print(
        f"fill={(x1 - x0 + 1) / 1024 * 100:.1f}% "
        f"margin L{x0} T{y0} R{1023 - x1} B{1023 - y1}"
    )


if __name__ == "__main__":
    main()
