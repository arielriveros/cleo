# Reference — render settings

Every field of `RenderSettings`, its type, its default and what it does. These are project-wide,
authored in the editor's **Renderer** mode ([guide](../editor/rendering.md)), saved with the
project and carried into a published build.

From script:

```ts
Game.getRenderSettings(): RenderSettings | undefined
Game.updateRenderSettings(settings: Partial<RenderSettings>): void
```

`updateRenderSettings` is partial-safe — omitted keys keep their current value.

> Camera-level effects are **not** here. The post-processing chain (which effects run, in what
> order) is authored per camera; see [post chain](../scripting/rendering.md#post-processing-chain).
> Displacement, tessellation and parallax live on the **material**, not in render settings.

---

## Quality

| Field | Type | Default | Meaning |
|---|---|---|---|
| `quality` | `QualityPreset` | `'high'` | `'low' \| 'medium' \| 'high' \| 'ultra' \| 'custom'`. Setting it moves several fields at once; `'custom'` touches nothing. |
| `renderScale` | `number` | `1.0` | Internal render resolution as a fraction of the canvas. |
| `clearColor` | `number[]` | `[0, 0, 0, 1]` | Background colour where nothing is drawn. |
| `frustumCulling` | `boolean` | `true` | Skip objects outside the camera frustum. |

**What each preset sets:**

| | ultra | high | medium | low |
|---|---|---|---|---|
| `renderScale` | 1.0 | 1.0 | 1.0 | 0.75 |
| cloud resolution / steps / light steps | 1.0 / 48 / 6 | 0.5 / 40 / 5 | 0.35 / 28 / 4 | 0.25 / 20 / 3 |
| `ssaoEnabled` / `ssaoSamples` / `ssaoResolutionScale` | on / 64 / 1.0 | on / 24 / 0.5 | on / 16 / 0.5 | **off** / 16 / 0.5 |
| `shadowMapResolution` / `shadowCascades` | 4096 / 4 | 2048 / 3 | 1024 / 3 | 1024 / 2 |
| `shadowFilterMode` / `shadowFilterRadius` | 1 / 2.0 | 0 / 1.0 | 0 / 1.0 | 0 / **0.0** |
| `bloomEnabled` | on | on | on | off |
| `motionBlurEnabled` | on | on | off | off |
| `taaEnabled` | on | on | on | off |

## Exposure and tone

| Field | Type | Default | Meaning |
|---|---|---|---|
| `exposure` | `number` | `2.0` | The **authored** exposure. Used only while auto-exposure is off. |
| `autoExposureEnabled` | `boolean` | `true` | Meter the frame and drive exposure from it. |
| `exposureCompensation` | `number` | `1.0` | Artist trim on the metered result, **in stops**. Positive is brighter. |
| `exposureMinEV` | `number` | `2.0` | Lower clamp on metered EV100. |
| `exposureMaxEV` | `number` | `17.0` | Upper clamp on metered EV100. |
| `exposureSpeedUp` | `number` | `3.0` | Adaptation rate as the scene gets brighter. `0` snaps. |
| `exposureSpeedDown` | `number` | `1.0` | Adaptation rate as it gets darker. |
| `toneMapper` | `ToneMapper` | `'agx'` | `'agx' \| 'aces' \| 'neutral' \| 'none'`. |
| `saturation` | `number` | `1.0` | Final saturation trim; `1` is untouched. |
| `colorGradingLut` | `string \| null` | `null` | Texture id of a grading LUT. `null` = no LUT. |
| `colorGradingIntensity` | `number` | `1.0` | How far toward the LUT the image is pulled. |

> ### EV and brightness run in opposite directions
>
> `exposure = REFERENCE_ILLUMINANCE / (1.2 · 2^EV)`. So **`exposureMinEV` is a ceiling on
> brightness**, not a floor. Lowering it is what makes a scene blow out.
>
> | EV100 | resulting exposure |
> |---|---|
> | 2 (the default floor) | 16384 |
> | 9 | 128 — a white screen for a night scene |
> | 14.5 | 2.8 |
> | 16.5 | 0.7 |
>
> With metering on, the renderer **ignores** `exposure` entirely. To ramp the look over time — a
> dusk-to-dawn cycle, say — animate `exposureCompensation`, which is applied after the clamp.

## Bloom

| Field | Type | Default | Meaning |
|---|---|---|---|
| `bloomEnabled` | `boolean` | derived | True whenever `bloomIntensity > 0`. |
| `bloomIntensity` | `number` | `0.35` | How much bloom is added back. `0` disables it. |
| `bloomThreshold` | `number` | `2.0` | Linear-HDR radiance a pixel must exceed to bloom. |
| `bloomKnee` | `number` | `0.5` | Softness of the threshold. |
| `bloomMaskEnabled` | `boolean` | `false` | Restrict bloom to lit surfaces. |

## Depth of field

Off by default; the focus fields mean nothing until `dofEnabled` is on. The lens is a thin lens
with a real aperture, so the near field blurs harder than the far field.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `dofEnabled` | `boolean` | `false` | |
| `dofFocusDistance` | `number` | `10.0` | Metres to the focal plane. **Ignored** on a camera that names a focus target — that camera measures the distance to the node instead. |
| `dofFocusRange` | `number` | `0.0` | Metres around the plane that stay perfectly sharp. |
| `dofAperture` | `number` | `2.8` | f-number as written on a lens barrel. Smaller is wider and shallower. |
| `dofMaxBlur` | `number` | `24.0` | Blur-radius clamp in pixels. This is a **cost** control. |

## Lens

| Field | Type | Default | Meaning |
|---|---|---|---|
| `lensFlareIntensity` | `number` | `0.0` | `0` = off. Generated from image brightness, so it occludes correctly. |
| `lensFlareThreshold` | `number` | `1.0` | Radiance needed to throw a flare. |
| `lensFlareGhosts` | `number` | `4` | Ghosts traced through the centre. Clamped to 8 (the shader's bound). |
| `lensFlareHaloWidth` | `number` | `0.45` | Halo radius in uv. `0` keeps the ghosts, drops the halo. |
| `lensDirtTexture` | `string \| null` | `null` | Texture id of a dirt mask. **`null` means the built-in mask**, not "none". |
| `lensDirtIntensity` | `number` | `0.0` | How much dirt boosts the bloom and flare it catches. `0` = off. |

> Note the polarity difference: `colorGradingLut: null` means *no LUT*, but `lensDirtTexture: null`
> means *the mask that ships with the engine*. Dirt is a property every real lens has, so the
> useful default is a sensible mask with the intensity as the switch.

## Vignette and grain

| Field | Type | Default | Meaning |
|---|---|---|---|
| `vignetteStrength` | `number` | `0.0` | `0` = off, `1` = corners fully dark. Applied **before** the tone curve, because that is what it physically is. |
| `vignetteRoundness` | `number` | `0.0` | `0` follows the frame aspect (as a real lens does); `1` is a circle. |
| `vignetteSmoothness` | `number` | `0.4` | Width of the falloff band. |
| `filmGrainIntensity` | `number` | `0.0` | `0` = off. ~`0.05` is subtle 35mm; past ~`0.3` reads as sensor noise. |
| `filmGrainSize` | `number` | `2.0` | Grain cell size in pixels. `1` aliases under TAA; 1.5–3 is filmic. |
| `filmGrainColored` | `boolean` | `false` | Tint each channel independently, as colour film does. |
| `chromaticAberrationStrength` | `number` | `0.0` | Channel separation toward the corners. |

## Antialiasing and motion blur

| Field | Type | Default | Meaning |
|---|---|---|---|
| `taaEnabled` | `boolean` | `true` | Temporal antialiasing. Deliberately a single switch — the feedback weights are not exposed. |
| `motionBlurEnabled` | `boolean` | `true` | Camera-reprojection motion blur. |
| `motionBlurIntensity` | `number` | `1.0` | Effective shutter length. |
| `motionBlurSamples` | `number` | `12` | Taps per pixel. |

Per-object motion blur can be suppressed on a node with `node.motionBlur = 'objectOnly' | 'none'`.

## Ambient occlusion and shading

| Field | Type | Default | Meaning |
|---|---|---|---|
| `ssaoEnabled` | `boolean` | preset | Screen-space AO. Deferred path only. |
| `ssaoRadius` | `number` | `0.5` | Sample radius in **world units**. |
| `ssaoPower` | `number` | `1.5` | Contrast of the occlusion term. |
| `ssaoBias` | `number` | `0.025` | Depth bias, to stop a surface occluding itself. |
| `ssaoSamples` | `number` | `24` | Samples per pixel. |
| `ssaoResolutionScale` | `number` | `0.5` | AO buffer size as a fraction of the render size. |
| `specularOcclusionEnabled` | `boolean` | `true` | Give the indirect specular lobe its own occlusion term. Off multiplies both lobes by the same number, which visibly strips the reflection off a polished floor in a corner. |
| `specularAaEnabled` | `boolean` | `true` | Widen roughness by sub-pixel normal variance so highlights stop flickering. PBR and terrain only. |
| `horizonOcclusionEnabled` | `boolean` | `true` | Drop indirect specular where the reflection ray points into the surface. This is the fix for the wet-looking rim on strongly normal-mapped surfaces at glancing angles. |

## Shadows

| Field | Type | Default | Meaning |
|---|---|---|---|
| `shadowsEnabled` | `boolean` | `true` | |
| `shadowMapResolution` | `number` | `2048` | Per cascade. 512 / 1024 / 2048 / 4096. |
| `shadowCascades` | `number` | `3` | 1–4. |
| `shadowDistance` | `number` | `100` | How far cascades cover. |
| `shadowSplitLambda` | `number` | `0.5` | Blend between uniform and logarithmic cascade splits. |
| `shadowDepthBias` | `number` | `0.03` | |
| `shadowNormalBias` | `number` | `1.5` | |
| `shadowFilterMode` | `number` | `0` | `0` = 3×3 PCF, `1` = 16-tap rotated Poisson. |
| `shadowFilterRadius` | `number` | `1.0` | Kernel radius in shadow texels. `0` collapses to one hard tap. |
| `shadowStrength` | `number` | `1.0` | How dark a shadowed pixel goes. |
| `shadowCascadeBlend` | `number` | `0.1` | Cross-fade width at cascade boundaries. |
| `shadowStabilize` | `boolean` | `true` | Snap the shadow frustum to texels so shadows stop crawling as the camera moves. |
| `shadowStagger` | `boolean` | `true` | Update distant cascades on alternating frames. |
| `shadowCasterPad` | `number` | `50` | How far outside the view casters are still gathered. |
| `spotShadowsEnabled` | `boolean` | `true` | |
| `spotShadowResolution` | `number` | `1024` | 256 / 512 / 1024 / 2048. |
| `spotShadowDistance` | `number` | `100` | |
| `spotShadowBias` | `number` | `0.0015` | |
| `pointShadowsEnabled` | `boolean` | `true` | |
| `pointShadowResolution` | `number` | `512` | **Per cube face.** 256 / 512 / 1024. |
| `pointShadowDistance` | `number` | `50` | |
| `pointShadowBias` | `number` | `0.0015` | |

> `shadowStagger` spreads cascade updates across frames. This makes the frame-time graph
> deliberately uneven — a periodic spike there is the feature working, not a leak.

## Foliage and terrain LOD

| Field | Type | Default | Meaning |
|---|---|---|---|
| `foliageCullDistance` | `number` | `65` | Beyond this, foliage instances are not drawn. |
| `foliageDensityFalloff` | `number` | engine constant | How density thins toward the cull distance. |
| `foliageCellSize` | `number` | `13` | Size of a foliage admission cell, in world units. |
| `terrainLodEnabled` | `boolean` | `true` | |
| `terrainLodDistance1` | `number` | `120` | Where terrain drops to the first reduced detail step. |
| `terrainLodDistance2` | `number` | `300` | Where it drops to the second. |
| `terrainLodStep1` | `number` | `2` | Detail divisor at LOD 1 (½). |
| `terrainLodStep2` | `number` | `4` | Detail divisor at LOD 2 (¼). |

## See also

[Rendering (editor)](../editor/rendering.md) · [Rendering (scripting)](../scripting/rendering.md) · [API index](api-index.md)
