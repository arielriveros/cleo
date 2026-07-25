// ============================================================================
//  SKETCH — full-screen "pencil drawing" post effect (SCREEN custom material)
// ============================================================================
//  Paste this into a screen-mode Custom Material's fragment body, then add it to
//  a camera's "Screen-Space Materials" list.
//
//  It turns the rendered frame into a hand-drawn graphite sketch:
//    · Sobel outlines from the color image  +  silhouette outlines from depth
//    · layered procedural cross-hatching that gets denser in the shadows
//    · ink on tinted paper, with a faint paper grain
//
//  Colors are authored in DISPLAY (sRGB) space and pushed back through the
//  inverse of the engine's present resolve (toSrgb(aces(hdr * u_exposure))), so
//  the paper white / ink black land exactly where you set them regardless of the
//  camera exposure. u_exposure is a built-in for screen passes.
//
//  Declare these in the Uniforms panel (bare names, shown here as u_<name>):
//    u_inkColor       vec3    line + hatch color      e.g.  0.10, 0.10, 0.13
//    u_paperColor     vec3    paper background        e.g.  0.94, 0.91, 0.84
//    u_edgeStrength   float   color-outline weight    e.g.  1.6
//    u_depthEdge      float   silhouette-outline wt   e.g.  1.2
//    u_hatchStrength  float   cross-hatch opacity 0-1 e.g.  0.9
//    u_hatchScale     float   hatch spacing (pixels)  e.g.  6.0
//    u_colorize       float   0 = graphite, 1 = tint  e.g.  0.0
// ----------------------------------------------------------------------------

// --- present-resolve inverse (so display colors survive exposure + ACES) -----
vec3 acesFilm(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 acesFilmInv(vec3 y) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    vec3 A = a - y * c;
    vec3 B = b - y * d;
    vec3 C = -y * e;
    return (-B + sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
}
// linear-HDR value that displays as `disp` (sRGB) after the final present
vec3 presentInverse(vec3 disp) {
    return acesFilmInv(toLinear(clamp(disp, 0.0, 1.0))) / max(u_exposure, 1e-4);
}

// --- perceptual brightness of the source frame at a UV ----------------------
float lumaOf(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float tone(vec2 uv) {
    vec3 c = texture(u_screenTexture, uv).rgb;
    float l = lumaOf(max(c, 0.0));
    l = l / (1.0 + l);                       // Reinhard: fold HDR into 0..1
    return pow(clamp(l, 0.0, 1.0), 1.0 / 2.2); // to a perceptual value
}

// --- Sobel edge magnitude on the perceptual value ---------------------------
float colorEdge(vec2 uv, vec2 texel) {
    float tl = tone(uv + texel * vec2(-1.0,  1.0));
    float  l = tone(uv + texel * vec2(-1.0,  0.0));
    float bl = tone(uv + texel * vec2(-1.0, -1.0));
    float  t = tone(uv + texel * vec2( 0.0,  1.0));
    float  b = tone(uv + texel * vec2( 0.0, -1.0));
    float tr = tone(uv + texel * vec2( 1.0,  1.0));
    float  r = tone(uv + texel * vec2( 1.0,  0.0));
    float br = tone(uv + texel * vec2( 1.0, -1.0));
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy =  tl + 2.0 * t + tr - bl - 2.0 * b - br;
    return sqrt(gx * gx + gy * gy);
}

// --- silhouette edges from the depth buffer (catches same-color contours) ----
float depthEdge(vec2 uv, vec2 texel) {
    float c = texture(u_depth, uv).r;
    if (c >= 1.0) return 0.0;                 // sky: no outline
    float l = texture(u_depth, uv - vec2(texel.x, 0.0)).r;
    float r = texture(u_depth, uv + vec2(texel.x, 0.0)).r;
    float d = texture(u_depth, uv - vec2(0.0, texel.y)).r;
    float u = texture(u_depth, uv + vec2(0.0, texel.y)).r;
    float g = abs(l - r) + abs(d - u);
    return g / max(c * (1.0 - c), 1e-4);      // normalize the nonlinear depth gradient
}

// --- one anti-aliased stroke set: 0 on a line, 1 in the gaps ----------------
float strokes(vec2 px, vec2 dir, float spacing) {
    float f = abs(fract(dot(px, dir) / spacing) - 0.5) * 2.0; // triangular, 0 at line
    return smoothstep(0.12, 0.4, f);
}

// --- layered cross-hatching: darker tones add more stroke directions --------
float hatching(vec2 px, float t) {
    float sp = max(u_hatchScale, 2.0);
    float ink = 1.0;                          // 1 = bare paper, 0 = fully inked
    if (t < 0.88) ink = min(ink, strokes(px, normalize(vec2( 1.0,  1.0)), sp));
    if (t < 0.66) ink = min(ink, strokes(px, normalize(vec2( 1.0, -1.0)), sp));
    if (t < 0.44) ink = min(ink, strokes(px, normalize(vec2( 0.0,  1.0)), sp * 0.8));
    if (t < 0.22) ink = min(ink, strokes(px, normalize(vec2( 1.0,  0.25)), sp * 0.7));
    return ink;
}

vec4 fragment() {
    vec2 texel = 1.0 / u_resolution;
    vec2 px    = fragTexCoord * u_resolution;

    vec3  src = texture(u_screenTexture, fragTexCoord).rgb;
    float t   = tone(fragTexCoord);

    // hatch shading
    float ink = hatching(px, t);
    ink = mix(1.0, ink, clamp(u_hatchStrength, 0.0, 1.0));

    // outlines: crisp union of color + depth edges
    float edge = max(colorEdge(fragTexCoord, texel) * u_edgeStrength,
                     depthEdge(fragTexCoord, texel) * u_depthEdge);
    edge = smoothstep(0.35, 0.7, edge);

    // paper, optionally tinted by the scene color
    vec3 sceneSrgb = toSrgb(clamp(src / (1.0 + src), 0.0, 1.0));
    vec3 paper = mix(u_paperColor, u_paperColor * (sceneSrgb + 0.25), clamp(u_colorize, 0.0, 1.0));

    // compose in DISPLAY space: paper -> darken by hatch -> stamp the outline
    vec3 col = mix(u_inkColor, paper, ink);
    col = mix(col, u_inkColor, edge);

    // faint paper grain
    float grain = fract(sin(dot(floor(px), vec2(12.9898, 78.233))) * 43758.5453);
    col *= 1.0 - 0.05 * grain;

    // hand the engine the linear-HDR value that reproduces `col` after present
    return vec4(presentInverse(col), 1.0);
}
