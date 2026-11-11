# Third-party notices

Code and data from other projects that ship inside the engine, with their licences.

## LTC area-light tables (`src/graphics/ltcTables.ts`)

The linearly transformed cosine fit for the GGX BRDF from Eric Heitz, Jonathan Dupuy, Stephen Hill and
David Neubelt, "Real-Time Polygonal-Light Shading with Linearly Transformed Cosines" (SIGGRAPH 2016),
https://github.com/selfshadow/ltc_code. The tables are taken from three.js
(`examples/jsm/lights/RectAreaLightUniformsLib.js`, release 0.160.0) by `tools/ltc/importTables.mjs`;
three.js distributes them under the MIT licence below. The edge integral in `chunks/areaLights.wgsl`
follows the same paper and three.js's implementation of it.

```
The MIT License

Copyright © 2010-2023 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
