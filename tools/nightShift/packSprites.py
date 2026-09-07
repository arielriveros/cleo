#!/usr/bin/env python3
"""
Pack the Night Shift pickup sprites into single-row atlases.

The pixel-platformer pack ships one PNG per frame, but an `animatedSprite` node plays frames out of a
TILESET -- a single image sliced on a fixed grid. So the frames have to be laid side by side once, and
this is that step.

Run it once; the output under `sprites/` is committed, and `build.mjs` reads those PNGs rather than the
zip. That keeps the project generator pure Node with no image dependency, and keeps the source zip (which
is gitignored) out of the build path entirely.

    python tools/nightShift/packSprites.py

Frames are laid out left to right, so tile index N is frame N and `columns` is the frame count. Nothing
is scaled or recoloured -- the atlas is the frames, concatenated.
"""

import io
import os
import sys
import zipfile

try:
    from PIL import Image
except ImportError:
    sys.exit("This needs Pillow: python -m pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE_ZIP = os.path.join(ROOT, "examples", "assets", "PixelPlatformerSet1v.1.1.zip")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sprites")

# name -> the frame members, in play order. Kept explicit rather than globbed: the pack numbers some
# sequences from 01 and the sort order of a glob is not the animation order in general.
SHEETS = {
    "pickup-score":    ["Anim/diamond-%02d.png" % i for i in range(1, 6)],
    "pickup-speed":    ["Anim/light-%02d.png" % i for i in range(1, 5)],
    "pickup-powerup":  ["Anim/torch-A-%02d.png" % i for i in range(1, 5)],
}


def pack(zf: zipfile.ZipFile, name: str, members: list) -> dict:
    frames = []
    for member in members:
        with zf.open(member) as handle:
            frames.append(Image.open(io.BytesIO(handle.read())).convert("RGBA"))

    width = max(f.width for f in frames)
    height = max(f.height for f in frames)
    if any(f.width != width or f.height != height for f in frames):
        # A ragged sequence would slice off-grid, and the misalignment shows up as the sprite jittering
        # rather than as an error -- so say so here instead.
        print("  ! %s has mixed frame sizes; centring each in a %dx%d cell" % (name, width, height))

    atlas = Image.new("RGBA", (width * len(frames), height), (0, 0, 0, 0))
    for i, frame in enumerate(frames):
        atlas.paste(frame, (i * width + (width - frame.width) // 2, (height - frame.height) // 2))

    path = os.path.join(OUT_DIR, name + ".png")
    atlas.save(path, "PNG", optimize=True)
    return {
        "name": name, "file": path, "columns": len(frames), "rows": 1,
        "tileWidth": width, "tileHeight": height,
        "imageWidth": atlas.width, "imageHeight": atlas.height,
        "bytes": os.path.getsize(path),
    }


def main() -> int:
    if not os.path.exists(SOURCE_ZIP):
        sys.exit("Missing %s -- it is gitignored, so it has to be present locally to re-pack." % SOURCE_ZIP)

    os.makedirs(OUT_DIR, exist_ok=True)
    with zipfile.ZipFile(SOURCE_ZIP) as zf:
        available = set(zf.namelist())
        for name, members in SHEETS.items():
            missing = [m for m in members if m not in available]
            if missing:
                sys.exit("%s: the zip has no %s" % (name, missing[0]))
            info = pack(zf, name, members)
            print("  %-16s %dx%d  %d frames  %d bytes"
                  % (info["name"], info["imageWidth"], info["imageHeight"], info["columns"], info["bytes"]))

    print("Wrote %d atlases to %s" % (len(SHEETS), OUT_DIR))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
