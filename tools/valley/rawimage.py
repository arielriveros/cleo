"""Raw RGBA8 <-> image files, for tools that run in Node and have no image codec.

  python rawimage.py decode <image> <out.rgba>          prints {"width": w, "height": h}
  python rawimage.py encode <in.rgba> <width> <height> <out.png>

Rows run top to bottom, 4 bytes per texel, no padding -- the layout `rgbaSampler` and the octahedral
baker (src/terrain/octahedralBake.ts) read and write.
"""

import json
import sys

from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def main(argv):
    if argv[1] == "decode":
        img = Image.open(argv[2]).convert("RGBA")
        with open(argv[3], "wb") as f:
            f.write(img.tobytes())
        print(json.dumps({"width": img.width, "height": img.height}))
    elif argv[1] == "encode":
        w, h = int(argv[3]), int(argv[4])
        with open(argv[2], "rb") as f:
            data = f.read()
        Image.frombytes("RGBA", (w, h), data).save(argv[5], optimize=True)
    else:
        raise SystemExit("usage: rawimage.py decode|encode ...")


if __name__ == "__main__":
    main(sys.argv)
