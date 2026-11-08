#!/usr/bin/env python3
"""
The FPS project's character maps (cut out of the FBXs by prepareCharacters.mjs) as base colour (JPEG), packed
AO/roughness/metal "ARM" (JPEG) and normal (PNG), the shapes tools/valley/prepare.py makes for the Hollow.

    python tools/fps/prepareTextures.py      # build/fps_prepared/<key>/*.png -> build/fps_prepared/textures/

Ch05, Ch15 and Ch35 are spec-gloss (converted with the Valley's metal_rough). Swat has no glossiness map: its
roughness is a constant, its metal zero.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "valley"))
import prepare as v  # noqa: E402  (tools/valley/prepare.py)
from PIL import Image  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "build" / "fps_prepared"
OUT = SRC / "textures"


def save_jpeg(im, name, size, q=88):
    im = v.fit(im.convert("RGB"), size)
    im.save(OUT / f"{name}.jpg", "JPEG", quality=q, optimize=True)


def save_png(im, name, size):
    im = v.fit(im.convert("RGB"), size)
    im.save(OUT / f"{name}.png", "PNG", optimize=True)


def spec_gloss(key, tiles, prefix):
    for tile in tiles:
        stem = SRC / key / f"{prefix}_{tile}"
        color, arm = v.metal_rough(v.load(Path(f"{stem}_Diffuse.png")), v.load(Path(f"{stem}_Specular.png")), v.load(Path(f"{stem}_Glossiness.png")))
        save_jpeg(color, f"{key}_{tile}_diff", 2048)
        save_jpeg(arm, f"{key}_{tile}_arm", 1024)
        save_png(v.load(Path(f"{stem}_Normal.png")), f"{key}_{tile}_nor", 2048)


def swat():
    for tile, stem in (("body", "Soldier_Body"), ("head", "Soldier_head")):
        d = v.load(SRC / "swat" / f"{stem}_diffuse.png")
        save_jpeg(d, f"swat_{tile}_diff", 2048)
        arm = Image.merge("RGB", (Image.new("L", (64, 64), 255), Image.new("L", (64, 64), 150), Image.new("L", (64, 64), 0)))
        arm.save(OUT / f"swat_{tile}_arm.jpg", "JPEG", quality=90)
        save_png(v.load(SRC / "swat" / f"{stem}_normal.png"), f"swat_{tile}_nor", 2048)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    spec_gloss("ch05", ("1001", "1002", "1003"), "Ch05")
    spec_gloss("ch15", ("1001", "1002"), "Ch15")
    if (SRC / "ch35").exists():
        spec_gloss("ch35", ("1001", "1002", "1003"), "Ch35")
    swat()
    files = [f for f in OUT.iterdir() if f.is_file()]
    print(f"wrote {len(files)} textures to {OUT.relative_to(ROOT)} ({sum(f.stat().st_size for f in files) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
