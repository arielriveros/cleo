#!/usr/bin/env python3
"""
Re-encode the Valley example's source textures into something an example can ship.

    python tools/valley/prepare.py          # build/  ->  build/valley_prepared/
    node tools/valley/build.mjs             # reads build/valley_prepared/ + the models in build/

The art in build/ arrives as it was exported: 4096^2 RGBA PNGs for one house (63 MB), 6 MB lossless
albedo PNGs for a 1k ground texture, a pine whose four maps live inside its GLB. Shipped as-is the example
would weigh several hundred megabytes for detail nobody can see at the distances it is viewed from.

The usual split for shipped textures: colour and packed AO/rough/metal
maps go out as JPEG; normal maps and cutout masks stay PNG. A normal map's channels are a direction, so
JPEG ringing shows up as shimmering facets; a mask's edge is the cutout itself.

Two traps in the source files, both handled here rather than in the generator:
  - Several of the props' PNGs carry an iCCP chunk with a bad CRC. Browsers skip a broken ancillary
    chunk, Pillow refuses the whole file, so the CRC check is switched off for the read.
  - The grass's alpha is its own PNG and the pine needles' alpha is the albedo's alpha channel. Both
    become a separate single-channel mask, which is the slot the engine's cutout reads (RED channel).

Output is deterministic (fixed quality, no metadata), so re-running it is a no-op for the generator.
"""

import io
import json
import struct
import sys
from pathlib import Path

from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True  # skips the ancillary-chunk CRC check (see above)

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "build"
OUT = SRC / "valley_prepared"

JPEG_QUALITY = 88


def load(path: Path) -> Image.Image:
    im = Image.open(path)
    im.load()
    return im


def grey8(im: Image.Image) -> Image.Image:
    """One 8-bit channel. A 16-bit greyscale PNG (the ground/rock/trail height maps) is SHIFTED down:
    Pillow's convert("L") clips I;16 at 255, which turned every one of those maps into flat white.
    A 16-bit grey+alpha map (rocks_ground_05) opens as LA or RGBA at 8 bits already, and keeps its grey."""
    if im.mode in ("LA", "La"):
        return im.getchannel("L")
    if im.mode in ("I;16", "I;16B", "I;16L", "I"):
        import numpy as np
        a = np.asarray(im, dtype=np.uint32)
        return Image.fromarray((a >> 8 if a.max() > 255 else a).astype("uint8"))
    return im.convert("L")


def mask_of(im: Image.Image) -> Image.Image:
    """The coverage: the alpha channel when it carries any, else the grey value (thatch's mask is RGB
    with an opaque alpha)."""
    if im.mode in ("RGBA", "LA"):
        a = im.getchannel("A")
        if a.getextrema()[0] < 255:
            return a
    return grey8(im)


def fit(im: Image.Image, size: int) -> Image.Image:
    """Downscale so the longer side is at most `size`; never upscale."""
    w, h = im.size
    s = min(1.0, size / max(w, h))
    if s >= 1.0:
        return im
    return im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)


def save_jpeg(im: Image.Image, name: str, size: int, grey: bool = False) -> None:
    im = fit(grey8(im) if grey else im.convert("RGB"), size)
    im.save(OUT / f"{name}.jpg", "JPEG", quality=JPEG_QUALITY, optimize=True)


def save_png(im: Image.Image, name: str, size: int, mode: str = "RGB") -> None:
    im = fit(grey8(im) if mode == "L" else im.convert(mode), size)
    im.save(OUT / f"{name}.png", "PNG", optimize=True)


def terrain(prefix: str, folder: str, base: str) -> None:
    tex = SRC / "terrain_textures" / folder / "textures"
    # Most sets name the colour map `_diff_`; forest_leaves_02 spells it `_diffuse_`.
    diff = tex / f"{base}_diff_1k.png"
    if not diff.exists():
        diff = tex / f"{base}_diffuse_1k.png"
    save_jpeg(load(diff), f"{prefix}_diff", 1024)
    save_png(load(tex / f"{base}_nor_gl_1k.png"), f"{prefix}_nor", 1024)
    save_jpeg(load(tex / f"{base}_arm_1k.png"), f"{prefix}_arm", 1024)
    save_png(load(tex / f"{base}_disp_1k.png"), f"{prefix}_disp", 512, "L")


def props() -> None:
    house = SRC / "props" / "house"
    save_jpeg(load(house / "003_diffuse.png"), "house_diff", 2048)
    save_png(load(house / "003_normal.png"), "house_nor", 2048)
    save_jpeg(load(house / "003_roughness.png"), "house_rough", 2048, grey=True)

    # long_house, silo and windmill ship the same three sets; long_house's copy is read.
    shared = SRC / "props" / "long_house" / "textures"
    save_jpeg(load(shared / "boards" / "tiled_dirty_planks.png"), "boards_diff", 1024)
    save_png(load(shared / "boards" / "tiled_dirty_planks_normal.png"), "boards_nor", 1024)
    save_jpeg(load(shared / "boards" / "tiled_dirty_planks_roughness.png"), "boards_rough", 1024, grey=True)
    save_jpeg(load(shared / "thatch_no_opacity" / "thatch_bc.png"), "thatch_diff", 1024)
    save_png(load(shared / "thatch_no_opacity" / "thatch_n.png"), "thatch_nor", 1024)
    save_jpeg(load(shared / "thatch_no_opacity" / "thatch_roughness.png"), "thatch_rough", 1024, grey=True)
    mask = load(shared / "thatch_with_opacity" / "thatch_opacity_mask.png")
    save_png(mask_of(mask), "thatch_mask", 1024, "L")

    dungeon = SRC / "wall_textures"
    for base in ("cobblestone_floor_09", "stone_brick_wall_001", "stone_wall_04", "castle_wall_slates"):
        tex = dungeon / f"{base}_1k" / "textures"
        save_jpeg(load(tex / f"{base}_diff_1k.png"), f"{base}_diff", 1024)
        save_png(load(tex / f"{base}_nor_gl_1k.png"), f"{base}_nor", 1024)
        save_jpeg(load(tex / f"{base}_arm_1k.png"), f"{base}_arm", 1024)


def grass() -> None:
    tex = SRC / "foliage" / "grass_medium_01_1k.gltf" / "textures"
    save_jpeg(load(tex / "grass_medium_01_diff_1k.jpg"), "grass_diff", 1024)
    save_jpeg(load(tex / "grass_medium_01_nor_gl_1k.jpg"), "grass_nor", 1024)  # already JPEG at the source
    save_jpeg(load(tex / "grass_medium_01_arm_1k.jpg"), "grass_arm", 1024)
    alpha = load(tex / "grass_medium_01_alpha_1k.png")
    save_png(mask_of(alpha), "grass_mask", 1024, "L")


def glb_images(path: Path) -> list:
    data = path.read_bytes()
    json_len = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + json_len])
    bin_start = 20 + json_len + 8
    out = []
    for img in doc["images"]:
        view = doc["bufferViews"][img["bufferView"]]
        off = bin_start + view.get("byteOffset", 0)
        out.append(Image.open(io.BytesIO(data[off:off + view["byteLength"]])))
    return doc, out


def pine() -> None:
    doc, images = glb_images(SRC / "foliage" / "realistic_pine.glb")
    tex = [t["source"] for t in doc["textures"]]
    bark, needles = doc["materials"][0], doc["materials"][1]
    pick = lambda m, key: images[tex[m[key]["index"]]] if key in m else images[tex[m["pbrMetallicRoughness"][key]["index"]]]
    save_jpeg(pick(bark, "baseColorTexture"), "pine_bark_diff", 1024)
    save_png(pick(bark, "normalTexture"), "pine_bark_nor", 1024)
    leaf = pick(needles, "baseColorTexture").convert("RGBA")
    save_jpeg(leaf, "pine_needles_diff", 1024)
    save_png(mask_of(leaf), "pine_needles_mask", 1024, "L")
    save_png(pick(needles, "normalTexture"), "pine_needles_nor", 1024)


def rock_moss() -> None:
    """The moss rocks ship roughness but no ARM: one is assembled (AO 1, roughness, metal 0), the layout
    every lit material in this example reads."""
    tex = SRC / "foliage" / "rock_moss_set_02_1k.gltf" / "textures"
    rough = grey8(load(tex / "rock_moss_set_02_rough_1k.jpg"))
    white = Image.new("L", rough.size, 255)
    black = Image.new("L", rough.size, 0)
    save_jpeg(Image.merge("RGB", (white, rough, black)), "rock_moss_arm", 1024)


def skull_cave() -> None:
    """The cave's three maps live inside its GLB: base colour, normal, and a metal/rough map whose
    channels (G roughness, B metal) become the ARM this example's materials read, with AO 1."""
    doc, images = glb_images(SRC / "props" / "skull_cave" / "source" / "model.glb")
    tex = [t["source"] for t in doc["textures"]]
    m = doc["materials"][0]
    pbr = m["pbrMetallicRoughness"]
    color = images[tex[pbr["baseColorTexture"]["index"]]]
    normal = images[tex[m["normalTexture"]["index"]]]
    mr = images[tex[pbr["metallicRoughnessTexture"]["index"]]].convert("RGB")
    _, g, b = mr.split()
    save_jpeg(color, "skull_cave_diff", 2048)
    save_png(normal, "skull_cave_nor", 2048)
    save_jpeg(Image.merge("RGB", (Image.new("L", g.size, 255), g, b)), "skull_cave_arm", 2048)


def water_normal(size: int = 512, seed: int = 1337) -> None:
    """
    A seamlessly tiling wave normal map for the pond (water.glsl samples it in world space).

    Generated, not sourced: build/ has no water texture. A height field is made in the FREQUENCY domain —
    random phases under a band-limited power-law spectrum — so its inverse FFT is periodic by
    construction and the map tiles with no seam. Slightly anisotropic (stretched along x) so the
    scrolling layers read as wind-driven ripples rather than isotropic noise.
    """
    import numpy as np
    rng = np.random.default_rng(seed)
    k = np.fft.fftfreq(size) * size
    kx, ky = np.meshgrid(k, k)
    kk = np.sqrt((kx * 0.75) ** 2 + ky ** 2)
    band = (kk > 2) & (kk < 64)
    amplitude = np.where(band, 1.0 / np.maximum(kk, 1.0) ** 1.9, 0.0)
    phase = rng.uniform(0, 2 * np.pi, (size, size))
    height = np.real(np.fft.ifft2(amplitude * np.exp(1j * phase)))
    height /= np.abs(height).max()
    # Central differences with wrap-around, so the slope is periodic too.
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    strength = 18.0
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(height)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    rgb = ((n * 0.5 + 0.5) * 255).round().clip(0, 255).astype('uint8')
    Image.fromarray(rgb).save(OUT / "water_nor.png", "PNG", optimize=True)


def main() -> None:
    if not SRC.exists():
        sys.exit(f"no {SRC}")
    OUT.mkdir(parents=True, exist_ok=True)
    terrain("ground", "brown_mud_leaves_01_1k", "brown_mud_leaves_01")
    terrain("trail", "rocky_trail_02_1k", "rocky_trail_02")
    terrain("rock", "rock_05_1k", "rock_05")
    terrain("snow", "snow_02_1k", "snow_02")
    terrain("forest", "forest_leaves_02_1k", "forest_leaves_02")
    terrain("rockydirt", "rocks_ground_05_1k", "rocks_ground_05")
    props()
    grass()
    pine()
    rock_moss()
    skull_cave()
    water_normal()
    total = sum(f.stat().st_size for f in OUT.iterdir())
    print(f"wrote {len(list(OUT.iterdir()))} textures to {OUT.relative_to(ROOT)} ({total / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
