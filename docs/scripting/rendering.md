# Rendering from script

Materials, lights, cameras and post-processing at runtime. Most of this is authored rather than
scripted; come here when a game needs to *change* the look — a damage flash, a night falling, a
scope overlay.

## Render settings

```ts
Game.getRenderSettings(): RenderSettings | undefined
Game.updateRenderSettings(settings: Partial<RenderSettings>): void
```

Partial-safe, so you write only what you are changing:

```ts
Game.updateRenderSettings({ saturation: 0.4, vignetteStrength: 0.6 })
```

Every field is in [Render settings](../reference/render-settings.md).

### Ramping the look over time

```ts
onUpdate(delta: number) {
  const t = this.progress                       // 0 at dusk, 1 at dawn
  Game.updateRenderSettings({
    exposureCompensation: lerp(this.nightEV, this.dayEV, t),
    saturation:           lerp(0.7, 1.0, t),
    vignetteStrength:     lerp(0.55, 0.15, t),
  })
}
```

Exposure, saturation and vignette are cheap and safe to write every frame.

> **With auto-exposure on, the renderer ignores `exposure` entirely.** Ramp
> `exposureCompensation` instead — it is applied after the metering clamp. And remember that
> `exposureMinEV` is a **ceiling on brightness**, not a floor; lowering it is what makes a scene
> blow out.

## Materials

```ts
Material.Basic(props, config?)      // unlit
Material.Default(props, config?)    // Blinn-Phong
Material.PBR(props?, config?)
Material.Cel(props?, config?)       // forward only
Material.Terrain(props?, config?)
```

```ts
class Material {
  type: MaterialType
  properties: Map<string, any>
  textures: Map<string, string>     // slot -> TextureManager id
  config: {
    side?: 'front' | 'back' | 'double'
    transparent?: boolean
    castShadow?: boolean
    probeable?: boolean
    wireframe?: boolean
  }
}
```

Reaching a material from a node:

```ts
const mesh = this.findNode('Body') as ModelNode
const material = mesh.model.material          // or model.materials[i] for a submesh
material.properties.set('emissive', [1, 0.3, 0])
```

Per-instance changes affect that instance only — which is what lets one burning enemy glow without
the rest of them glowing too.

### Alpha

`alphaCutoff` of `0` **disables** cutout. Above zero it tests the `mask` texture's red channel (PBR
also falls back to base-colour alpha). Cutout casts correct shadows; blended transparency does not,
so prefer cutout for foliage and fences.

### Height and parallax

These live on the **material**, not in render settings: a height map (`textures.displacementMap`), a
depth in **world units** (`displacementScale`), `invertHeight` for depth maps, and `clipSilhouette`
to also clip flat `0..1`-mapped faces at their uv border.

A PBR material with a height map always runs parallax occlusion mapping — there is no on/off flag.
The march carves curved silhouettes (the ray bends with the surface's measured curvature and is
discarded where it leaves the relief) and writes the relief's depth, so intersections follow it.

> Depth is in world units for materials authored since that changed; older materials keep UV units,
> because converting the stored number needs the mesh's chart scale and one material can sit on both
> a cube and a photogrammetry scan. The editor shows what one UV unit is worth on the mesh in front
> of you and converts when you switch.

## Custom materials

```ts
CustomMaterial.Create(baseType: CustomBaseType,
                      renderMode: 'forward' | 'deferred' | 'screen' = 'forward',
                      config?)

fragmentSource: string
uniforms: CustomUniform[]      // 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'bool'
                               // | 'sampler2D' | 'samplerCube'
refreshType(): void
get wgslIsCurrent: boolean
```

Setting a uniform from script is how you animate a custom shader. Values are stored under the uniform's
**bare** name (the shader sees it as `u_dissolve`):

```ts
const custom = mesh.model.material as CustomMaterial
custom.properties.set('dissolve', this.dissolveAmount)
```

### Seeing the scene behind a transparent material

A **transparent forward** material (`config.transparent: true`) can read the opaque scene behind it,
which is what refraction, water depth and soft intersections need:

```glsl
vec2  cleoScreenUV()               // this fragment's uv in the screen-sized scene buffers
bool  cleoHasScene()               // true while the buffers below hold this frame's scene
float cleoSceneViewDepth(vec2 uv)  // view depth of the opaque scene there (the sky reads as far)
float cleoFragViewDepth()          // view depth of this fragment — subtract for the thickness between
vec3  cleoSceneColor(vec2 uv)      // the opaque scene's colour there, linear HDR
```

The colour is copied only on frames where a visible transparent material's source names
`cleoSceneColor` / `u_sceneColor`. An opaque material has no such snapshot (`cleoHasScene()` is
false). `tools/valley/water.glsl` is a complete example.

On WebGPU, a published game has no GLSL translator: a custom material renders from the WGSL saved
with it (`compiledWgsl`), which the material inspector writes when it compiles the shader, and which is
ignored if the source or the engine prelude changed since (`compiledWgslHash`).

> A custom material's `type` is a **content hash of its shader source**, so it changes on every
> edit. That is why post-chain entries reference screen materials **by index**
> (`material:<n>` into `CameraNode.screenMaterials`) rather than by type.

## Lights

Intensities are photometric.

| Light | Unit | Default |
|---|---|---|
| `DirectionalLight` | lux | `100000` |
| `PointLight` | lumens | `1500` |
| `Spotlight` | lumens | `1500` |

Other fields: `range` (default `10`), `sourceRadius` (`0.05`), directional `angularRadius`
(`0.00465`), spot `cutOff` / `outerCutOff` / `coneScaleOffset`. `resetToPhysicalDefaults()` puts a
light back to plausible values.

```ts
const lamp = this.findNode('Lamp') as LightNode
lamp.light.intensity = 3000
lamp.castShadows = false
```

Scene ambient is scene-level, in lux:

```ts
this.scene.ambientLight = [0.02, 0.03, 0.05]
```

`MAX_LIGHTS = 1024`. A light past the cap gets `index = -1` and is dropped from shadow passes.

> A flickering light is best done with `intensity` and shadows **off** — shadow updates are the
> expensive half.

## Sun and sky

To animate a day/night cycle, rotate the **directional light** and let the sky's `useSceneSun` read
it. Do it on a timer, not every frame.

> Writing `sunDirection`, `sunColor`, `sunIntensity`, `exposure` or `groundColor` on a
> `SkyAtmosphereNode` sets the re-bake flag **unconditionally**, ahead of the ~0.3° angular
> throttle. Touch any of them per frame and you bake six cube faces plus a mip chain per frame.
>
> And call `skyLight.markDirty()` periodically if the sun moves: the ambient projection decides it
> is stale by comparing cubemap object identity, and the re-bake renders into the *same* texture, so
> indirect light otherwise freezes at the first sun position.

Rotating the light every 0.25 s and marking the sky light dirty every 2 s is enough for a smooth
cycle at a fraction of the cost.

## Cameras

```ts
const cam = this.findNode('Camera') as CameraNode
cam.active = true
cam.focusTarget = this.findNode('Player')     // depth of field focuses here
cam.postChain = [...]
```

A camera that names a focus target measures the distance to that node and ignores
`dofFocusDistance`.

### Post-processing chain

The chain is the **middle** of the pipeline only — `compose`, `exposure` and `present` are fixed
anchors and are not entries.

```ts
type BuiltinEffectId = 'depthOfField' | 'godRays' | 'bloom' | 'lensFlare'
                     | 'chromatic' | 'vignette' | 'filmGrain'
type MaterialEffectId = `material:${number}`      // index into CameraNode.screenMaterials

interface PostChainEntry { readonly effect: PostEffectId; readonly enabled: boolean }
```

```ts
DEFAULT_POST_CHAIN
resolvePostChain(...) ; isDefaultChain(...) ; isBuiltinEffect(id) ; materialIndexOf(id)
```

`enabled: false` means "present, in this position, not running" — not removed. That distinction
matters because the position is authored data you do not want to lose by toggling an effect.

Screen materials run in camera order and only for the **active** camera.

## Textures

```ts
TextureManager.Instance.addTextureFromPath / Data / Base64 / Bytes / File
TextureManager.Instance.getTexture(id: string): Texture | undefined
TextureManager.Instance.removeTexture(id: string): void
```

Channel-packed maps (metallic/roughness/occlusion combined) are **engine-owned**: their ids are
identified by `isDerivedTextureId` and they are never assignable or serializable.

## Screenshots

```ts
renderer.screenshot(scene, size = 256): Promise<string>
```

Returns a data URL. Useful for a save-slot thumbnail.

## Statistics

```ts
frameStats ; sceneStats ; sceneStatsDetail ; physicsStats ; aiStats
gpuProfiler ; frameHistory ; cpuProfiler
```

The same numbers the editor's performance HUD shows — see
[Rendering (editor)](../editor/rendering.md#performance-hud).

## See also

[Render settings](../reference/render-settings.md) · [Rendering (editor)](../editor/rendering.md) · [Models and materials (editor)](../editor/models-and-materials.md)
