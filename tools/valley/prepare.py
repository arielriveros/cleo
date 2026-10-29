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
import shutil
import struct
import sys
import urllib.request
import zipfile
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


def unpack() -> None:
    """Poly Haven downloads arrive zipped: each is extracted once, beside itself, to the folder layout the
    rest of this script and the generator read: `foliage/<name>.gltf/` (the zip's own name less `.zip`)
    and `terrain_textures/<name>/textures/`."""
    for folder in ("foliage", "terrain_textures"):
        for z in sorted((SRC / folder).glob("*.zip")):
            dest = z.with_suffix("")
            if dest.exists():
                continue
            with zipfile.ZipFile(z) as f:
                f.extractall(dest)
            print(f"unpacked {z.relative_to(SRC)}")


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
        # The pack's own AO and roughness maps, one each (its ARM holds the same two plus an all-zero metal).
        save_jpeg(load(tex / f"{base}_ao_1k.png"), f"{base}_ao", 1024, grey=True)
        save_jpeg(load(tex / f"{base}_rough_1k.png"), f"{base}_rough", 1024, grey=True)


def gltf_material(path: Path, index: int, prefix: str, size: int = 1024) -> None:
    """One glTF material's maps as this example's set: `_diff`, `_nor`, `_arm`, and `_emissive` when it
    has one. glTF keeps roughness in G and metal in B; an occlusion map that shares that image (an ORM
    pack) already has AO in R, so the image IS an ARM. Without one, R is set to 1 (no occlusion).
    A metal/rough map on a second UV set is skipped: parts carry one UV set, and the scalars stand in."""
    doc, images = glb_images(path)
    tex = [t["source"] for t in doc["textures"]]
    m = doc["materials"][index]
    pbr = m.get("pbrMetallicRoughness", {})
    pick = lambda ref: images[tex[ref["index"]]]
    save_jpeg(pick(pbr["baseColorTexture"]), f"{prefix}_diff", size)
    if "normalTexture" in m:
        save_png(pick(m["normalTexture"]), f"{prefix}_nor", size)
    mr = pbr.get("metallicRoughnessTexture")
    if mr and mr.get("texCoord", 0) == 0:
        r, g, b = pick(mr).convert("RGB").split()
        if m.get("occlusionTexture", {}).get("index") != mr["index"]:
            r = Image.new("L", g.size, 255)
        save_jpeg(Image.merge("RGB", (r, g, b)), f"{prefix}_arm", size)
    if "emissiveTexture" in m:
        save_jpeg(pick(m["emissiveTexture"]), f"{prefix}_emissive", min(size, 512))


def dungeon_props() -> None:
    """The dungeon's own wood, metal and carved-stone sets (its rocky walls and slabs use wall_textures
    above), the torches, the bonfire's campfire, and the props that dress the dungeon."""
    structure = SRC / "props" / "medieval_dungeon_structure (1).glb"
    doc, _ = glb_images(structure)
    names = [m["name"] for m in doc["materials"]]
    for name in ("stone_hewn", "wood_planks", "wood_old", "iron", "brass", "cast_iron", "gold", "sky", "void"):
        gltf_material(structure, names.index(name), f"dungeon_{name}")

    gltf_material(SRC / "props" / "medieval_torch.glb", 0, "standing_torch")
    campfire = SRC / "props" / "campfire_fire_with_stones.glb"
    doc, _ = glb_images(campfire)
    for i, m in enumerate(doc["materials"]):
        gltf_material(campfire, i, f"campfire_{m['name']}")
    gltf_material(SRC / "props" / "bookcase.glb", 0, "bookcase")
    gltf_material(SRC / "props" / "dungeon_cage.glb", 0, "cage")

    # The wall torch's maps are separate 4k greyscale PNGs; roughness and metalness become its ARM.
    torch = SRC / "props" / "wall_torch_model" / "textures"
    save_jpeg(load(torch / "torch_BaseColor.png"), "wall_torch_diff", 1024)
    save_png(load(torch / "torch_Normal.png"), "wall_torch_nor", 1024)
    rough = grey8(load(torch / "torch_Roughness.png"))
    metal = grey8(load(torch / "torch_Metalness.png"))
    save_jpeg(Image.merge("RGB", (Image.new("L", rough.size, 255), rough, metal)), "wall_torch_arm", 1024)


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


# The cutout plants' alpha maps. Poly Haven's glTF zips leave them out (the JPEG colour maps carry no
# alpha), so each is fetched from the asset's own file list once and kept beside its textures.
CUTOUTS = {
    "fern": ("fern_02", "fern_02_alpha_1k.png"),
    "jacaranda_leaves": ("jacaranda_tree", "jacaranda_tree_leaves_alpha_1k.png"),
    "rooibos": ("wild_rooibos_bush", "wild_rooibos_bush_alpha_1k.png"),
}


def cutout_masks() -> None:
    """One single-channel mask per cutout plant, the slot the engine's cutout reads (RED). The alpha
    maps are grey images (16-bit for the fern; RGBA with a near-opaque alpha for the jacaranda), so the
    grey value is the coverage, never the alpha channel."""
    for prefix, (asset, file) in CUTOUTS.items():
        src = SRC / "foliage" / f"{asset}_1k.gltf" / "textures" / file
        if not src.exists():
            url = f"https://dl.polyhaven.org/file/ph-assets/Models/png/1k/{asset}/{file}"
            print(f"fetching {url}")
            urllib.request.urlretrieve(url, src)
        im = load(src)
        save_png(grey8(im if im.mode.startswith("I") else im.convert("RGB")), f"{prefix}_mask", 1024, "L")


def jacaranda() -> None:
    """The jacaranda's colour maps, copied here because its impostor bake decodes from this folder. Its
    other maps (and every other new plant's) ship from build/foliage as the 1k JPEGs they already are."""
    tex = SRC / "foliage" / "jacaranda_tree_1k.gltf" / "textures"
    for part in ("trunk", "branches", "leaves"):
        shutil.copyfile(tex / f"jacaranda_tree_{part}_diff_1k.jpg", OUT / f"jacaranda_{part}_diff.jpg")


def knight() -> None:
    """The knight player's three materials (blinn1/2/3): base colour, normal and the packed
    occlusion/roughness/metal map glTF shares between the two slots, which is an ARM as it stands. The
    two cut-out materials (the mohawk, straps and chain mail) get a mask from the base colour's alpha."""
    path = SRC / "medieval_knight__sculpture__game_ready.glb"
    doc, images = glb_images(path)
    tex = [t["source"] for t in doc["textures"]]
    for index, m in enumerate(doc["materials"]):
        prefix = f"knight_{m['name']}"
        gltf_material(path, index, prefix, 2048)
        if m.get("alphaMode") == "MASK":
            color = images[tex[m["pbrMetallicRoughness"]["baseColorTexture"]["index"]]].convert("RGBA")
            save_png(color.getchannel("A"), f"{prefix}_mask", 2048, "L")


def metal_rough(diffuse: Image.Image, specular: Image.Image, gloss: Image.Image):
    """Specular/glossiness maps as this example's metal/rough set: `(base colour, ARM)`.

    The per-texel solve of Khronos's glTF spec-gloss converter: metalness from how far the specular
    colour sits above a dielectric's 4% against the diffuse brightness, the base colour blended between
    the diffuse (dielectric) and specular (metal) readings, roughness = 1 - glossiness. Worked in linear
    light; AO is 1 (neither file has one)."""
    import numpy as np
    size = diffuse.size
    lin = lambda im: (np.asarray(im.convert("RGB").resize(size, Image.LANCZOS), dtype=np.float32) / 255.0) ** 2.2
    d, sp = lin(diffuse), lin(specular)
    g = np.asarray(grey8(gloss).resize(size, Image.LANCZOS), dtype=np.float32) / 255.0
    bright = lambda c: np.sqrt(0.299 * c[..., 0] ** 2 + 0.587 * c[..., 1] ** 2 + 0.114 * c[..., 2] ** 2)
    diel = 0.04
    one_minus = 1.0 - sp.max(axis=-1)
    db, sb = bright(d), bright(sp)
    a_ = diel
    b_ = db * one_minus / (1 - diel) + sb - 2 * diel
    c_ = diel - sb
    disc = np.maximum(b_ * b_ - 4 * a_ * c_, 0)
    metal = np.where(sb < diel, 0.0, np.clip((-b_ + np.sqrt(disc)) / (2 * a_), 0, 1))
    m = metal[..., None]
    from_diffuse = d * (one_minus / (1 - diel) / np.maximum(1 - metal, 1e-4))[..., None]
    from_spec = (sp - diel * (1 - m)) / np.maximum(m, 1e-4)
    base = np.clip(from_diffuse + (from_spec - from_diffuse) * m * m, 0, 1)
    to8 = lambda x: Image.fromarray((np.clip(x, 0, 1) * 255 + 0.5).astype("uint8"))
    color = to8(base ** (1 / 2.2))
    arm = Image.merge("RGB", (Image.new("L", size, 255), to8(1 - g), to8(metal)))
    return color, arm


def strong_knight() -> None:
    """The Elite Knight's three materials (cloth, knight, weapons). The file is spec-gloss
    (KHR_materials_pbrSpecularGlossiness): diffuse, a specular RGB + glossiness A map and a normal map,
    converted to base colour / ARM (see metal_rough)."""
    path = SRC / "strong_knight.glb"
    doc, images = glb_images(path)
    tex = [t["source"] for t in doc["textures"]]
    for m in doc["materials"]:
        sg = m["extensions"]["KHR_materials_pbrSpecularGlossiness"]
        diffuse = images[tex[sg["diffuseTexture"]["index"]]]
        spec_gloss = images[tex[sg["specularGlossinessTexture"]["index"]]].convert("RGBA")
        color, arm = metal_rough(diffuse, spec_gloss.convert("RGB"), spec_gloss.getchannel("A"))
        prefix = f"strong_knight_{m['name']}"
        save_jpeg(color, f"{prefix}_diff", 2048)
        save_jpeg(arm, f"{prefix}_arm", 1024)
        save_png(images[tex[m["normalTexture"]["index"]]], f"{prefix}_nor", 2048)


def hollow() -> None:
    """The Hollow's three UDIM tiles (Ch05_1001..1003), each a diffuse, specular, glossiness and normal
    map cut out of the FBX by prepareEnemy.mjs, as base colour / ARM / normal (see metal_rough)."""
    src = OUT / "enemy"
    if not (src / "Ch05_1001_Diffuse.png").exists():
        sys.exit("no build/valley_prepared/enemy — run `node tools/valley/prepareEnemy.mjs` first")
    for tile in ("1001", "1002", "1003"):
        stem = src / f"Ch05_{tile}"
        color, arm = metal_rough(load(Path(f"{stem}_Diffuse.png")), load(Path(f"{stem}_Specular.png")), load(Path(f"{stem}_Glossiness.png")))
        save_jpeg(color, f"hollow_{tile}_diff", 2048)
        save_jpeg(arm, f"hollow_{tile}_arm", 1024)
        save_png(load(Path(f"{stem}_Normal.png")), f"hollow_{tile}_nor", 2048)


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
    unpack()
    terrain("ground", "brown_mud_leaves_01_1k", "brown_mud_leaves_01")
    terrain("trail", "rocky_trail_02_1k", "rocky_trail_02")
    terrain("rock", "rock_05_1k", "rock_05")
    terrain("snow", "snow_02_1k", "snow_02")
    terrain("forest", "forest_leaves_02_1k", "forest_leaves_02")
    terrain("rockydirt", "rocks_ground_05_1k", "rocks_ground_05")
    terrain("dirt", "dirt_1k", "dirt")
    terrain("clay", "clay_plaster_1k", "clay_plaster")
    terrain("sand", "coast_sand_02_1k", "coast_sand_02")
    terrain("path", "concrete_rock_path_1k", "concrete_rock_path")
    props()
    dungeon_props()
    grass()
    pine()
    jacaranda()
    cutout_masks()
    knight()
    strong_knight()
    hollow()
    rock_moss()
    skull_cave()
    water_normal()
    files = [f for f in OUT.iterdir() if f.is_file()]
    total = sum(f.stat().st_size for f in files)
    print(f"wrote {len(files)} textures to {OUT.relative_to(ROOT)} ({total / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
