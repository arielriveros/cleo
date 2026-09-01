import { useState, useEffect, useMemo } from 'react';
import { ModelNode, Material, CustomMaterial, TERRAIN_RELIEF_ENABLED, MeshDisplacer, MAX_TESS_LEVEL, tessSegments, tessBudget, TextureManager } from 'cleo';
import { useEventBus } from '../../EventBusContext';
import { vec3ToHex } from '../../../utils/UtilFunctions';
import { newCustomMaterial } from '../../../utils/customMaterials';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';
import CustomMaterialEditor from './CustomMaterialEditor';
import { PropertyTable, PropertyRow, Field, Select, NumberInput, Slider, Toggle, ColorInput, Section } from '../../../components/ui';
import { MaterialIcon } from '../sectionIcons';

const DISPLACE_HINT = 'Subdivide this mesh in a compute pass and displace it by the Height map, so the relief becomes real geometry — a real silhouette, real self-shadowing, correct depth. Each step multiplies the triangle count by four. WebGPU only; WebGL2 draws the mesh as authored.'
const TERRAIN_HEIGHT_HINT = 'Depth is a fraction of one texture repeat, the same as on any mesh — so this material reads the same on both. The Terrain Material inspector shows what that is in metres. Relief is drawn per fragment: it shades and self-shadows but has no silhouette, and physics follows the sculpted surface.';

export default function MaterialEditor(props: {node: ModelNode}) {
  if (!props.node.model) {
    return <div>No model available for this node.</div>;
  }
  
  const model = props.node.model;
  const material = model.material;

  type ShaderType = 'basic' | 'blinn_phong' | 'pbr' | 'custom';
  const detectShaderType = (t: string): ShaderType =>
    t.startsWith('custom') ? 'custom'
    : (t.includes('blinn_phong') || t.includes('default')) ? 'blinn_phong' : t.includes('pbr') ? 'pbr' : 'basic';
  const [shaderType, setShaderType] = useState<ShaderType>(detectShaderType(material.type as string));

  const [diffuse, setDiffuse] = useState(vec3ToHex(material.properties.get('diffuse')));
  const [specular, setSpecular] = useState(vec3ToHex(material.properties.get('specular')));
  const [ambient, setAmbient] = useState(vec3ToHex(material.properties.get('ambient')));
  const [shininess, setShininess] = useState(material.properties.get('shininess') || 32);
  const [emission, setEmission] = useState(vec3ToHex(material.properties.get('emissive')));

  const [baseColor, setBaseColor] = useState<string>(vec3ToHex(material.properties.get('baseColor') || [1,1,1]));
  const [metallic, setMetallic] = useState<number>(material.properties.get('metallic') ?? 0);
  const [roughness, setRoughness] = useState<number>(material.properties.get('roughness') ?? 1);
  const [reflectance, setReflectance] = useState<number>(material.properties.get('reflectance') ?? 0.5);
  const [emissiveFactor, setEmissiveFactor] = useState<string>(vec3ToHex(material.properties.get('emissiveFactor') || [0,0,0]));
  const [emissiveIntensity, setEmissiveIntensity] = useState<number>(material.properties.get('emissiveIntensity') ?? 1);
  const [pbrOpacity, setPbrOpacity] = useState<number>(material.properties.get('opacity') ?? 1);
  // Parallax occlusion depth; inert without a Height map.
  const [dispScale, setDispScale] = useState<number>(
    (material as any).displacementScale ?? material.properties.get('dispScale') ?? 0.05);
  // Which unit that depth is in. Terrain has its own (metres, baked) and never shows this control.
  const [depthInWorld, setDepthInWorld] = useState<boolean>(
    material.properties.get('depthInWorld') !== false);
  // Subdivision level for compute tessellation. On the MATERIAL rather than the model: the surface
  // decides how it wants to be represented, and a material moved onto another mesh carries its relief.
  const [displaceLevel, setDisplaceLevel] = useState<number>(
    Number(material.properties.get('displaceLevel') ?? 0));
  // World units spanned by one UV unit on THIS mesh. The number that decides whether a uv depth means
  // millimetres or metres, and the one thing that made parallax on an atlas-mapped scan unusable while
  // looking correct on every primitive: a tiling material puts one repeat inside a few centimetres, a
  // photogrammetry scan puts one repeat around the whole object (measured: 47.97 on a scanned branch).
  const worldPerUv = useMemo(
    () => (model.geometry ? model.geometry.worldPerUv() : 1),
    [model.geometry, (model.geometry as any)?.geometryVersion]);

  // What the chosen subdivision costs on THIS mesh, and whether the mesh can carry the map at it.
  // `texelsPerEdge` is the number that decides the level: it halves every step, and below about two
  // the vertex grid starts resolving the height map's own features instead of the shape they sit on.
  const displaceBudget = useMemo(() => {
    const triangles = Math.floor((model.geometry?.indices.length ?? 0) / 3);
    return tessBudget(triangles, tessSegments(displaceLevel), 14);
  }, [model.geometry, displaceLevel]);
  const heightWidth = (() => {
    const id = material.textures.get('displacementMap');
    const image = id ? (TextureManager.Instance.getTexture(id)?.data as HTMLImageElement | undefined) : undefined;
    return image?.naturalWidth ?? 0;
  })();
  // MEASURED from the chart, not guessed from the triangle count — see `Geometry.meanUvEdge`. The
  // guess read an 8-triangle ramp as 181 texels per edge when the truth is 512, which is why it looked
  // like the feature was broken rather than like the mesh being too coarse for the map.
  const texelsPerEdge = heightWidth > 0 && model.geometry
    ? (model.geometry.meanUvEdge() * heightWidth) / tessSegments(displaceLevel)
    : 0;
  // Whether the Height map is really a DEPTH map (white = deep), the convention most downloaded PBR
  // packs ship. Nothing can detect this from the bytes, and the wrong answer inverts the relief.
  const [invertHeight, setInvertHeight] = useState<boolean>(
    !!((material as any).invertHeight ?? material.properties.get('invertHeight')));
  // Discard where the march walks off the face, so the outline follows the height field.
  const [clipSilhouette, setClipSilhouette] = useState<boolean>(!!material.properties.get('clipSilhouette'));
  // A terrain paint layer, which mounts this editor whole. It marches its height map exactly as a
  // standard material does, so Depth and Invert apply — but Clip silhouette does not: that test is
  // against a 0..1 uv chart and terrain is tiled, so it has no border to clip to.
  const isTerrain = (material as any).terrainMaterial === true
    || (material as any).foliageInclude !== undefined;
  // Cutout threshold, shared by all three shader types. 0 means no cutout.
  const [alphaCutoff, setAlphaCutoff] = useState<number>(material.properties.get('alphaCutoff') ?? 0);
  const [defaultOpacity, setDefaultOpacity] = useState<number>(material.properties.get('opacity') ?? 1);

  const [basicColor, setBasicColor] = useState(
    vec3ToHex(material.properties.get('color') ?? [1,1,1])
  );
  const [basicOpacity, setBasicOpacity] = useState<number>(
    material.properties.get('opacity') ?? 1
  );

  const [options, setOptions] = useState<{ wireframe: boolean; transparent: boolean; side: 'front' | 'back' | 'double'; castShadow: boolean; probeable: boolean;}>(
  {
    wireframe: material.config.wireframe ?? false,
    transparent: material.config.transparent ?? false,
    side: material.config.side ?? 'front',
    castShadow: material.config.castShadow ?? false,
    probeable: material.config.probeable ?? true,
  });

  useEffect(() => {
    setShaderType(detectShaderType(material.type as string));

    setDiffuse(vec3ToHex(material.properties.get('diffuse')));
    setSpecular(vec3ToHex(material.properties.get('specular')));
    setAmbient(vec3ToHex(material.properties.get('ambient')));
    setShininess(material.properties.get('shininess') || 32);
    setEmission(vec3ToHex(material.properties.get('emissive')));

    setBaseColor(vec3ToHex(material.properties.get('baseColor') || [1,1,1]));
    setMetallic(material.properties.get('metallic') ?? 0);
    setRoughness(material.properties.get('roughness') ?? 1);
    setReflectance(material.properties.get('reflectance') ?? 0.5);
    setEmissiveFactor(vec3ToHex(material.properties.get('emissiveFactor') || [0,0,0]));
    setEmissiveIntensity(material.properties.get('emissiveIntensity') ?? 1);
    setPbrOpacity(material.properties.get('opacity') ?? 1);
    setDefaultOpacity(material.properties.get('opacity') ?? 1);

    setBasicColor(vec3ToHex(material.properties.get('color') ?? [1,1,1]));
    setBasicOpacity(material.properties.get('opacity') ?? 1);

    setOptions({
      wireframe: material.config.wireframe ?? false,
      transparent: material.config.transparent ?? false,
      side: material.config.side ?? 'front',
      castShadow: material.config.castShadow ?? false,
      probeable: material.config.probeable ?? true,
    });

  }, [props.node])

  useEffect(() => {
    // Custom materials own their type key (a content hash) and properties; the instance swap to and from
    // CustomMaterial happens in handleShaderTypeChange.
    if (shaderType === 'custom') return;

    material.type = shaderType as any;

    if (shaderType === 'basic') {
      const carried = material.properties.get('color') || material.properties.get('baseColor') || material.properties.get('diffuse') || [1,1,1];
      material.properties.set('color', carried);
      if (material.properties.get('opacity') === undefined) material.properties.set('opacity', 1.0);
      if (material.properties.get('hasTexture') === undefined) material.properties.set('hasTexture', false);
    } else if (shaderType === 'blinn_phong') {
      // Carry the main color/emissive over from PBR/basic so the object keeps its look.
      const carried = material.properties.get('diffuse') || material.properties.get('baseColor') || material.properties.get('color') || [1,1,1];
      material.properties.set('diffuse', carried);
      if (!material.properties.get('specular')) material.properties.set('specular', [1,1,1]);
      if (!material.properties.get('ambient')) material.properties.set('ambient', carried);
      if (!material.properties.get('emissive')) material.properties.set('emissive', material.properties.get('emissiveFactor') || [0,0,0]);
      if (material.properties.get('shininess') === undefined) material.properties.set('shininess', 32.0);
      if (material.properties.get('opacity') === undefined) material.properties.set('opacity', 1.0);
      if (material.properties.get('reflectivity') === undefined) material.properties.set('reflectivity', 0.0);
    } else if (shaderType === 'pbr') {
      // Carry the main color/emissive over from default/basic so the object keeps its look.
      const carried = material.properties.get('baseColor') || material.properties.get('diffuse') || material.properties.get('color') || [1,1,1];
      material.properties.set('baseColor', carried);
      if (material.properties.get('metallic') === undefined) material.properties.set('metallic', 0.0);
      if (material.properties.get('roughness') === undefined) material.properties.set('roughness', 1.0);
      if (material.properties.get('reflectance') === undefined) material.properties.set('reflectance', 0.5);
      if (material.properties.get('opacity') === undefined) material.properties.set('opacity', 1.0);
      if (!material.properties.get('emissiveFactor')) material.properties.set('emissiveFactor', material.properties.get('emissive') || [0,0,0]);
      if (material.properties.get('hasBaseColorTexture') === undefined) material.properties.set('hasBaseColorTexture', false);
      if (material.properties.get('hasMetallicMap') === undefined) material.properties.set('hasMetallicMap', false);
      if (material.properties.get('hasRoughnessMap') === undefined) material.properties.set('hasRoughnessMap', false);
      if (material.properties.get('hasNormalMap') === undefined) material.properties.set('hasNormalMap', false);
      if (material.properties.get('hasOcclusionMap') === undefined) material.properties.set('hasOcclusionMap', false);
      if (material.properties.get('emissiveIntensity') === undefined) material.properties.set('emissiveIntensity', 1.0);
      if (material.properties.get('hasEmissiveMap') === undefined) material.properties.set('hasEmissiveMap', false);
    }
  }, [shaderType, material]);

  useEffect(() => {
    material.config.wireframe = options.wireframe;
    material.config.transparent = options.transparent;
    material.config.side = options.side;
    material.config.castShadow = options.castShadow;
    material.config.probeable = options.probeable;
  }, [options, material])

  const eventEmitter = useEventBus();

  useEffect(() => { eventEmitter.emit('TEXTURES_CHANGED') }, [])

  // Switching to or from 'custom' swaps the material INSTANCE, carrying the config across; built-in to
  // built-in stays on the same instance. Read model.material fresh each render so the swap is picked up.
  const handleShaderTypeChange = (next: ShaderType) => {
    const cur = detectShaderType(model.material.type as string);
    if (next === cur) return;
    const cfg = { ...model.material.config };
    if (next === 'custom') {
      model.material = newCustomMaterial('pbr', 'forward', cfg);
    } else if (cur === 'custom') {
      model.material = next === 'basic' ? Material.Basic({}, cfg)
        : next === 'pbr' ? Material.PBR({}, cfg)
        : Material.Default({}, cfg);
    }
    setShaderType(next);
    eventEmitter.emit('SCENE_CHANGED');
  };

  const markMaterialDirty = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'material', node: props.node });
  const setColor = (key: string, setter: (hex: string) => void) => (c: [number, number, number]) => {
    model.material.properties.set(key, c);
    setter(vec3ToHex(c));
    markMaterialDirty();
  };
  const setNum = (key: string, setter: (v: number) => void) => (v: number) => {
    model.material.properties.set(key, v);
    setter(v);
    markMaterialDirty();
  };
  const updateOption = (patch: Partial<typeof options>) => { setOptions((prev) => ({ ...prev, ...patch })); markMaterialDirty(); };

  // Called as a function, not a component, so each TextureInspector stays mounted across re-renders.
  // -------------------------------------------------------------------------------------------
  // The Height section, rendered by all three shader types.
  //
  // In all three deliberately, not just PBR where the parallax march lives: a TERRAIN paint layer can
  // be based on any material type and reads its height from this slot, which is the same reason Basic
  // and Blinn-Phong carry a Height texture slot at all. The Mode row is the part that is terrain-only.
  // -------------------------------------------------------------------------------------------
  // Terrain and ordinary materials both MARCH their height map now, with the same unit and the same
  // meaning, so there is nothing here to gate on the material kind any more. A terrain layer briefly
  // displaced the terrain's own vertices instead, and these rows forked on that.
  const setHeightProp = (key: string, value: any) => {
    // Terrain layers keep their height settings on the TerrainMaterial itself rather than in the
    // properties map: Terrain._writeLayerUniforms fans each one out to `u_<key>{i}`, one per painted
    // layer, so there is no single uniform to write.
    if (isTerrain) (model.material as any)[key === 'dispScale' ? 'displacementScale' : key] = value;
    else model.material.properties.set(key, value);
    markMaterialDirty();
  };

  // HIDDEN FOR TERRAIN while `TERRAIN_RELIEF_ENABLED` is off. The engine writes a depth of zero for a
  // terrain layer, so Depth, Invert and the Height slot would all be controls that change nothing —
  // which is worse than their absence, because the only way to discover it is to author with them and
  // wonder why the ground never moves. A mesh material keeps every one of them; only terrain is off.
  //
  // The height map is still read for the height-aware layer blend, so it is not that the slot is
  // meaningless on terrain — it is that the RELIEF half of it is switched off. When the flag comes back
  // this returns with it and nothing else here changes.
  const showHeight = !isTerrain || TERRAIN_RELIEF_ENABLED;

  const heightSection = showHeight ? (
    <Section title='Height' hint={isTerrain ? TERRAIN_HEIGHT_HINT : undefined}>
      <PropertyTable columns={['40%', '60%']}>
        {/* ONE unit everywhere: a fraction of one texture repeat. The march offsets texture
            coordinates, so a repeat is the only length either surface knows about, and that is what
            makes the same material read the same on a mesh and on a terrain layer.

            It was briefly WORLD METRES on terrain, because a layer's relief was baked into the terrain's
            vertices and a bake works in metres. One authored number driving two mechanisms forced a unit
            that meant nothing to the texture: 6 cm on a 3.2 m brick is 2% of the feature where the same
            map on a mesh gets 24%, so terrain looked flat beside an identical material. The Terrain
            Material inspector quotes the repeat in metres beside Tiling, which is what turns this
            fraction back into a distance. */}
        <PropertyRow label='Depth' hint={depthInWorld
          ? `Relief depth in world units. One UV unit is ${worldPerUv.toFixed(2)} on this mesh, so this is ${(dispScale / Math.max(worldPerUv, 1e-6)).toFixed(4)} of a texture repeat.`
          : `A fraction of one texture repeat. One UV unit is ${worldPerUv.toFixed(2)} world units on this mesh, so this is ${(dispScale * worldPerUv).toFixed(3)} units of relief.`}>
          {/* The world range is the uv range converted, so nothing the old control could reach becomes
              unreachable — and on a cube, where one repeat IS one unit, the two are identical. */}
          <Slider min={0} max={depthInWorld ? 0.5 * worldPerUv : 0.5}
                  step={(depthInWorld ? 0.5 * worldPerUv : 0.5) / 200}
                  value={dispScale}
                  onChange={(v) => { setHeightProp('dispScale', v); setDispScale(v); }} />
        </PropertyRow>
        {/* The readout that would have saved a week. A depth in uv is meaningless until you know what a
            uv unit is worth, and nothing in the editor said. */}
        {!isTerrain && (
          <PropertyRow label='Scale'>
            <span className='text-xs text-muted'>
              1 UV = {worldPerUv.toFixed(2)} units{'  ·  '}
              relief {(depthInWorld ? dispScale : dispScale * worldPerUv).toFixed(3)} units
            </span>
          </PropertyRow>
        )}
        {!isTerrain && (
          <PropertyRow label='Depth unit' hint='World units keep one material reading the same on a cube, on tiled ground and on a photogrammetry atlas. UV units are the older meaning, a fraction of one texture repeat, and are what a project saved before this existed keeps.'>
            <Toggle label='World units' checked={depthInWorld}
                    onChange={(c) => {
                      // Convert the NUMBER as the unit changes, so the surface does not jump: the
                      // control is switching how a depth is spelled, not how deep the relief is.
                      const converted = c ? dispScale * worldPerUv : dispScale / Math.max(worldPerUv, 1e-6);
                      setHeightProp('depthInWorld', c); setDepthInWorld(c);
                      setHeightProp('dispScale', converted); setDispScale(converted);
                    }} />
          </PropertyRow>
        )}
        {!isTerrain && (
          <PropertyRow label='Subdivision' hint={DISPLACE_HINT}>
            {MeshDisplacer.Instance.canDisplace ? (
              <div className='flex items-center gap-2 w-full'>
                <Slider min={0} max={MAX_TESS_LEVEL} step={1} value={displaceLevel}
                        onChange={(v) => { setHeightProp('displaceLevel', v); setDisplaceLevel(v); }} />
                <span className='text-xs text-muted whitespace-nowrap'>
                  {displaceLevel === 0 ? 'off' : `x${tessSegments(displaceLevel) ** 2}`}
                </span>
              </div>
            ) : (
              <span className='text-xs text-muted'>Needs WebGPU — this device has no compute shader.</span>
            )}
          </PropertyRow>
        )}
        {!isTerrain && displaceLevel > 0 && (
          <PropertyRow label='Cost'>
            <span className='text-xs text-muted'>
              {displaceBudget.triangles.toLocaleString()} triangles{'  ·  '}
              {(displaceBudget.vertexBytes / 1e6).toFixed(1)} MB
              {texelsPerEdge > 0 ? `  ·  ~${texelsPerEdge.toFixed(0)} texels/edge` : ''}
            </span>
          </PropertyRow>
        )}
        {/* The number that explains a flat result, which otherwise reads as the feature not working.
            Displacement band-limits to the mip matching its vertex spacing — correct, and it means a
            mesh far coarser than its map carries only the map's lowest frequencies. */}
        {!isTerrain && displaceLevel > 0 && texelsPerEdge > 8 && (
          <PropertyRow label=''>
            <span className='text-xs text-warning'>
              One edge spans {texelsPerEdge.toFixed(0)} texels, so the geometry can only carry the
              lowest frequencies of this map and will look nearly flat. Raise the level, tile the UVs,
              or leave the detail to the normal map.
            </span>
          </PropertyRow>
        )}
        {/* A height map is white at the PEAKS. A depth map - what `*_disp.png` in most PBR packs
            actually is - is white in the CREVICES. They are the same bytes, so nothing can tell them
            apart; getting it wrong turns brick into mortar rather than looking slightly off. If the
            relief reads inside out, this is the switch. */}
        <PropertyRow label='Depth map' divider={!isTerrain}>
          <Toggle label='Invert' checked={invertHeight}
                  onChange={(c) => { setHeightProp('invertHeight', c); setInvertHeight(c); }} />
        </PropertyRow>

        {/* Parallax only. The only thing a march can do about a BORDER: it offsets texture coordinates
            and never moves a vertex, so an outline is straight by construction - this discards where
            the ray walks off the face instead, biting the height field into the edge. It can only carve
            inward, never bulge out. Displacement has no use for it, because it moves the edge itself.

            Off by default and deliberately not inferred: the test is against the 0..1 uv rectangle,
            which is a real border only on a surface mapped 0..1 - a cube face, a quad. Terrain is
            tiled, so it never gets this row at all. */}
        {!isTerrain &&
        <PropertyRow label='Silhouette' divider={false}>
          <Toggle label='Clip at UV border' checked={clipSilhouette} onChange={(c) => {
            model.material.properties.set('clipSilhouette', c);
            setClipSilhouette(c);
            markMaterialDirty();
          }} />
        </PropertyRow>}

        {/* The limit that IS still real, and the one that replaced it. Terrain no longer carries a
            layer's relief in its vertices, so vertex spacing does not bound it — the march does, and a
            march has no silhouette and fades out under minification. What bounds it instead is the
            texture's world scale: depth is a fraction of a repeat, and at a coarse tiling a repeat is
            metres wide, so the same authored number is a very different distance. The Terrain Material
            inspector quotes the repeat beside Tiling for exactly that reason. */}
      </PropertyTable>
    </Section>
  ) : null;

  const texSlot = (label: string, tex: string) => (
    <div className='flex flex-col items-center gap-1'>
      <span className='text-[10px] text-muted'>{label}</span>
      <TextureInspector tex={tex} material={model.material} />
    </div>
  );

  return (
    <Collapsable title='Material' icon={<MaterialIcon />} persistKey='material'>
      <div className='w-full p-2'>
        <Field label='Shader'>
          <Select value={shaderType} onChange={(e) => handleShaderTypeChange(e.target.value as ShaderType)}>
            <option value='basic'>Basic</option>
            <option value='blinn_phong'>Blinn-Phong</option>
            <option value='pbr'>PBR</option>
            <option value='custom'>Custom (shader)</option>
          </Select>
        </Field>

        {shaderType === 'custom' && <CustomMaterialEditor node={props.node} />}

        {shaderType === 'blinn_phong' && (
          <>
            <Section title='Colors'>
              <PropertyTable columns={['40%', '60%']}>
                <PropertyRow label='Diffuse'><ColorInput color={diffuse} onChange={setColor('diffuse', setDiffuse)} /></PropertyRow>
                <PropertyRow label='Specular'><ColorInput color={specular} onChange={setColor('specular', setSpecular)} /></PropertyRow>
                <PropertyRow label='Ambient'><ColorInput color={ambient} onChange={setColor('ambient', setAmbient)} /></PropertyRow>
                <PropertyRow label='Emission'><ColorInput color={emission} onChange={setColor('emissive', setEmission)} /></PropertyRow>
                <PropertyRow label='Shininess'><NumberInput value={Number(shininess)} onChange={setNum('shininess', setShininess)} /></PropertyRow>
                <PropertyRow label='Opacity' divider={false}><Slider min={0} max={1} step={0.01} value={defaultOpacity} onChange={setNum('opacity', setDefaultOpacity)} /></PropertyRow>
              </PropertyTable>
            </Section>
            <Section title='Textures'>
              <div className='flex flex-wrap gap-3'>
                {texSlot('Diffuse', 'baseTexture')}
                {texSlot('Specular', 'specularMap')}
                {texSlot('Normal', 'normalMap')}
                {texSlot('Emission', 'emissiveMap')}
                {texSlot('Mask', 'maskMap')}
                {texSlot('Reflectivity', 'reflectivityMap')}
                {/* Inert on this material type — only the PBR chunks carry the parallax march. It is
                    here because a TERRAIN paint layer can be based on any material type and reads its
                    height from this one slot, for the height-aware blend. */}
                {showHeight && texSlot('Height', 'displacementMap')}
              </div>
            </Section>
            {heightSection}
            <Section title='Cutout'>
              <PropertyTable columns={['40%', '60%']}>
                {/* The Mask slot lives with the other textures above; this is just its threshold. It
                    replaces a hardcoded 0.5, and defaults to 0.5 for any material that predates it. */}
                <PropertyRow label='Alpha cutoff' divider={false}>
                  <Slider min={0} max={1} step={0.01} value={alphaCutoff} onChange={setNum('alphaCutoff', setAlphaCutoff)} />
                </PropertyRow>
              </PropertyTable>
            </Section>
          </>
        )}

        {shaderType === 'basic' && (
          <>
            <Section title='Properties'>
              <PropertyTable columns={['40%', '60%']}>
                <PropertyRow label='Color'><ColorInput color={basicColor} onChange={setColor('color', setBasicColor)} /></PropertyRow>
                <PropertyRow label='Opacity' divider={false}><Slider min={0} max={1} step={0.01} value={basicOpacity} onChange={setNum('opacity', setBasicOpacity)} /></PropertyRow>
              </PropertyTable>
            </Section>
            <Section title='Textures'>
              <div className='flex flex-wrap gap-3'>
                {texSlot('Texture', 'texture')}
                {/* Inert on this material type — only the PBR chunks carry the parallax march. It is
                    here because a TERRAIN paint layer can be based on any material type and reads its
                    height from this one slot, for the height-aware blend. */}
                {showHeight && texSlot('Height', 'displacementMap')}
              </div>
            </Section>
            {heightSection}
            <Section title='Cutout'>
              <PropertyTable columns={['40%', '60%']}>
                {/* The mask is read from RED, so a grayscale map is what belongs here. 0 disables the
                    cutout entirely; anything above it discards where the mask falls below. */}
                <PropertyRow label='Alpha cutoff'>
                  <Slider min={0} max={1} step={0.01} value={alphaCutoff} onChange={setNum('alphaCutoff', setAlphaCutoff)} />
                </PropertyRow>
                <PropertyRow label='Mask' divider={false}>
                  <TextureInspector tex='maskMap' material={model.material} />
                </PropertyRow>
              </PropertyTable>
            </Section>
          </>
        )}

        {shaderType === 'pbr' && (
          <>
            <Section title='Properties'>
              <PropertyTable columns={['40%', '60%']}>
                <PropertyRow label='Base Color'><ColorInput color={baseColor} onChange={setColor('baseColor', setBaseColor)} /></PropertyRow>
                <PropertyRow label='Metallic'><Slider min={0} max={1} step={0.01} value={metallic} onChange={setNum('metallic', setMetallic)} /></PropertyRow>
                <PropertyRow label='Roughness'><Slider min={0} max={1} step={0.01} value={roughness} onChange={setNum('roughness', setRoughness)} /></PropertyRow>
                {/* Dielectric specular level. 0.5 is the neutral default and reproduces the fixed 4%
                    reflectance every non-metal in this engine used to have, so leaving it alone changes
                    nothing. The useful range is narrow and low: water sits near 0.35, skin near 0.42,
                    gemstones between 0.55 and 0.7. Has no effect at metallic 1. */}
                <PropertyRow label='Reflectance'><Slider min={0} max={1} step={0.01} value={reflectance} onChange={setNum('reflectance', setReflectance)} /></PropertyRow>
                <PropertyRow label='Opacity'><Slider min={0} max={1} step={0.01} value={pbrOpacity} onChange={setNum('opacity', setPbrOpacity)} /></PropertyRow>
                <PropertyRow label='Emissive'><ColorInput color={emissiveFactor} onChange={setColor('emissiveFactor', setEmissiveFactor)} /></PropertyRow>
                {/* The colour is a hex picker and so cannot exceed 1 per channel — which is below the
                    brightness at which anything happens, because bloom thresholds in display-referred
                    terms and a mid-tone emissive lands exactly ON the default threshold. The colour is
                    the hue; this is how hot. Above ~2 an emissive surface starts to bloom. */}
                <PropertyRow label='Emissive power' divider={false}>
                  <Slider min={0} max={20} step={0.1} value={emissiveIntensity} onChange={setNum('emissiveIntensity', setEmissiveIntensity)} />
                </PropertyRow>
              </PropertyTable>
            </Section>
            <Section title='Textures'>
              <div className='flex flex-wrap gap-3'>
                {/* Metallic/Roughness/Occlusion are authored separately and combined into one packed
                    texture by the engine before they reach the shader (see systems/texturePacker.ts).
                    Assigning the SAME map to several of these marks it pre-packed (glTF ORM order),
                    and it is then reused as-is instead of being re-combined. */}
                {texSlot('Base Color', 'baseColorTexture')}
                {texSlot('Metallic', 'metallicMap')}
                {texSlot('Roughness', 'roughnessMap')}
                {texSlot('Normal', 'normalMap')}
                {texSlot('Occlusion', 'occlusionMap')}
                {texSlot('Emissive', 'emissiveMap')}
                {showHeight && texSlot('Height', 'displacementMap')}
              </div>
            </Section>
            {heightSection}
            <Section title='Cutout'>
              <PropertyTable columns={['40%', '60%']}>
                {/* The mask is read from RED, so a grayscale map is what belongs here. 0 disables the
                    cutout entirely; anything above it discards where the mask falls below. */}
                <PropertyRow label='Alpha cutoff'>
                  <Slider min={0} max={1} step={0.01} value={alphaCutoff} onChange={setNum('alphaCutoff', setAlphaCutoff)} />
                </PropertyRow>
                <PropertyRow label='Mask' divider={false}>
                  <TextureInspector tex='maskMap' material={model.material} />
                </PropertyRow>
              </PropertyTable>
            </Section>
          </>
        )}

        <Section title='Options'>
          <div className='flex flex-col gap-1.5'>
            <Toggle label='Wireframe' checked={options.wireframe} onChange={(c) => updateOption({ wireframe: c })} />
            <Toggle label='Transparent' checked={options.transparent} onChange={(c) => updateOption({ transparent: c })} />
            <Toggle label='Cast Shadow' checked={options.castShadow} onChange={(c) => updateOption({ castShadow: c })} />
            <Toggle label='Probeable' checked={options.probeable} onChange={(c) => updateOption({ probeable: c })} />
            <Field label='Side'>
              <Select value={options.side} onChange={(e) => updateOption({ side: e.target.value as 'front' | 'back' | 'double' })}>
                <option value='front'>Front</option>
                <option value='back'>Back</option>
                <option value='double'>Both</option>
              </Select>
            </Field>
          </div>
        </Section>
      </div>
    </Collapsable>
  )
}
