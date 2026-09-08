#!/usr/bin/env python3
"""
Downscale the zombie's textures for the Night Shift example.

    node --max-old-space-size=8192 tools/nightShift/importZombie.mjs   # extracts them first
    python tools/nightShift/packZombieTextures.py

Mixamo embeds four 4096x4096 PNGs in the character FBX -- 87.6 MB for one enemy, against the 35.7 MB
the player's mannequin costs and the 157 MB the whole example currently weighs. A shambler in a horde
does not need 4K, so each map is halved to 2048.

Diffuse maps go out as JPEG; normal maps stay PNG. That split is not fussiness: JPEG's chroma
subsampling and ringing land in a normal map as surface noise, because its channels are a direction
rather than a colour, and the artifacts show up as shimmering facets under a moving light.

Run it once; the output under `zombie/` is committed and `build.mjs` reads those files, exactly as
`packSprites.py` does for the pickup atlases. That keeps the generator pure Node with no image
dependency, and keeps the gitignored source FBX out of the build path entirely.
"""

import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("This needs Pillow: python -m pip install Pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SOURCE_DIR = os.path.join(ROOT, "build", "zombie", "extracted")
OUT_DIR = os.path.join(HERE, "zombie")

SIZE = 2048
JPEG_QUALITY = 90

# stem -> whether it is a normal map. The stems are the FBX's own names, and `importZombie.mjs` maps
# the same ones onto stable texture ids -- keep the two lists in step.
MAPS = {
    "Ch10_1001_Diffuse": False,
    "Ch10_1001_Normal": True,
    "Ch10_1002_Diffuse": False,
    "Ch10_1002_Normal": True,
}


def main():
    if not os.path.isdir(SOURCE_DIR):
        sys.exit("No extracted textures. Run tools/nightShift/importZombie.mjs first.")

    os.makedirs(OUT_DIR, exist_ok=True)
    total_in = 0
    total_out = 0

    for stem, is_normal in MAPS.items():
        source = os.path.join(SOURCE_DIR, stem + ".png")
        if not os.path.isfile(source):
            sys.exit("Missing %s -- re-run importZombie.mjs." % source)

        total_in += os.path.getsize(source)
        with Image.open(source) as image:
            # LANCZOS on a normal map shortens the vectors slightly at high-frequency detail; the shader
            # renormalizes, so this is the right filter for both and the alternative (nearest) aliases.
            resized = image.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)

            if is_normal:
                out = os.path.join(OUT_DIR, stem + ".png")
                resized.save(out, "PNG", optimize=True)
            else:
                out = os.path.join(OUT_DIR, stem + ".jpg")
                resized.save(out, "JPEG", quality=JPEG_QUALITY, subsampling=0)

        size = os.path.getsize(out)
        total_out += size
        print("%-20s %dx%d -> %dx%d  %6.1f MB -> %5.2f MB  %s"
              % (stem, image.width, image.height, SIZE, SIZE,
                 os.path.getsize(source) / 1048576, size / 1048576,
                 os.path.basename(out)))

    print("\n%.1f MB -> %.2f MB (%.0f%% smaller)"
          % (total_in / 1048576, total_out / 1048576,
             100 * (1 - total_out / total_in)))


if __name__ == "__main__":
    main()
