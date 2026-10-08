#!/usr/bin/env python3
"""Draw Cue's app icon and write it as an .icns: the overlay's own mark (a ring around a dot, the
Settings button glyph) on a graphite macOS-grid tile. Pillow + iconutil, no image assets in git.
  python3 scripts/make-icon.py dist/Cue.icns
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 4096                        # draw at 4x 1024 and downsample, for clean edges
u = S / 1024                    # one unit of Apple's 1024 icon grid
body = (100 * u, 100 * u, 924 * u, 924 * u)  # 824 px tile, 100 px margin
radius = 185 * u


def mask(box, r):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, r, fill=255)
    return m


def vertical_gradient(top, bottom):
    column = Image.new("RGB", (1, S))
    for y in range(S):
        t = y / (S - 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return column.resize((S, S))


icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# Soft drop shadow under the tile, as on Apple's template.
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
shadow.putalpha(mask((body[0], body[1] + 12 * u, body[2], body[3] + 12 * u), radius).point(lambda a: a * 0.35))
icon.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14 * u)))

tile_mask = mask(body, radius)
tile = vertical_gradient((46, 49, 54), (11, 12, 13)).convert("RGBA")
tile.putalpha(tile_mask)
icon.alpha_composite(tile)

# A faint glow behind the mark gives the flat tile some depth.
cx = cy = S / 2
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((cx - 300 * u, cy - 300 * u, cx + 300 * u, cy + 300 * u), fill=(255, 255, 255, 34))
glow = glow.filter(ImageFilter.GaussianBlur(120 * u))
glow.putalpha(Image.composite(glow.getchannel("A"), Image.new("L", (S, S), 0), tile_mask))
icon.alpha_composite(glow)

# Hairline highlight along the top edge of the tile.
edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(edge).rounded_rectangle(body, radius, outline=(255, 255, 255, 40), width=round(3 * u))
fade = vertical_gradient((255, 255, 255), (0, 0, 0)).convert("L")
edge.putalpha(Image.composite(edge.getchannel("A"), Image.new("L", (S, S), 0), fade))
icon.alpha_composite(edge)

# The mark: the 24-unit glyph (ring r=9, stroke 2; dot r=3.2) scaled to a 480 px box.
g = 480 * u / 24
mark = ImageDraw.Draw(icon)
ring, stroke, dot = 9 * g, 2.3 * g, 3.2 * g
white = (255, 255, 255, 235)
mark.ellipse((cx - ring - stroke / 2, cy - ring - stroke / 2, cx + ring + stroke / 2, cy + ring + stroke / 2), outline=white, width=round(stroke))
mark.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=white)

out = Path(sys.argv[1] if len(sys.argv) > 1 else "Cue.icns")
out.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    iconset = Path(tmp) / "Cue.iconset"
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        icon.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
        icon.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)
print(f"wrote {out}")
