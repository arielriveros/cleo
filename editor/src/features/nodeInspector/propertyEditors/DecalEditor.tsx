import type { DecalNode, DecalAffects, DecalColor, DecalPattern, DecalRadialPattern, DecalRadialCurve, DecalRadialShape, DecalReceivers } from 'cleo';
import { useState, useEffect } from 'react';
import Collapsable from '../../../components/Collapsable';
import { PropertyTable, PropertyRow, Select, NumberInput, Slider, Toggle, ColorInput, Section, Hint } from '../../../components/ui';
import { DecalIcon } from '../sectionIcons';
import { useEventBus } from '../../EventBusContext';
import { vec3ToHex } from '../../../utils/UtilFunctions';

const SIZE_HINT = 'Full extent of the projection box at scale 1, in metres. The decal projects straight down the box’s local −Y axis onto whatever lies inside it; the node’s own scale multiplies this.';
const ANGLE_FADE_HINT = 'How the decal fades on surfaces turned away from the projector. 0 turns the test off, so it also lands on walls and back faces inside the box.';
const DEPTH_FADE_HINT = 'Feathers the decal toward the box’s top and bottom faces, as a fraction of its half-height. 0 is a hard cut.';
const SORT_HINT = 'Where decals overlap, the higher number lands on top. Ties are broken by id, never by distance.';
const SURFACE_HINT = 'Roughness, metallic and ambient occlusion. They share one coverage, as in Unreal’s DBuffer.';
const RECEIVERS_HINT = 'Terrain only keeps rocks, props and foliage standing inside the box clean. It costs one extra depth pass over the terrain while such a decal is on screen.';
const RADIAL_HINT = 'A procedural gradient instead of the material, for ground indicators: the outer colour at the rim blends to the inner one at the centre along the chosen curve, with an optional ring on the rim.';
const CURVE_HINT = 'How the gradient falls from the centre to the rim. Power follows the exponent; the others hold the inner colour over the inner part of the radius and fall over the falloff band, like the terrain brush curves of the same names.';

type DecalState = {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  opacity: number;
  sortOrder: number;
  angleFade: number;
  depthFade: number;
  affects: DecalAffects;
  receivers: DecalReceivers;
  pattern: DecalPattern;
  radial: DecalRadialPattern;
};

/** A copy of everything the panel edits. Copies, never the node's live `affects`/`radial` objects. */
function readDecal(node: DecalNode): DecalState {
  const r = node.radial;
  return {
    sizeX: node.size[0],
    sizeY: node.size[1],
    sizeZ: node.size[2],
    opacity: node.opacity,
    sortOrder: node.sortOrder,
    angleFade: node.angleFade,
    depthFade: node.depthFade,
    affects: { ...node.affects },
    receivers: node.receivers,
    pattern: node.pattern,
    radial: {
      ...r,
      innerColor: [...r.innerColor] as DecalColor,
      outerColor: [...r.outerColor] as DecalColor,
      ringColor: [...r.ringColor] as DecalColor,
    },
  };
}

/** An RGBA colour: the swatch for the (sRGB) rgb and a slider for the alpha, which is the coverage. */
function RgbaInput(props: { value: DecalColor; onChange: (c: DecalColor) => void }) {
  const [r, g, b, a] = props.value;
  return (
    <div className='flex items-center gap-2'>
      <ColorInput className='shrink-0' color={vec3ToHex([r, g, b])} onChange={(c) => props.onChange([c[0], c[1], c[2], a])} />
      <Slider className='flex-1 min-w-0' min={0} max={1} step={0.01} value={a} title='Alpha (coverage)'
        onChange={(v) => props.onChange([r, g, b, v])} />
    </div>
  );
}

export default function DecalEditor(props: { node: DecalNode }) {
  const [state, setState] = useState<DecalState>(() => readDecal(props.node));

  useEffect(() => {
    setState(readDecal(props.node));
  }, [props.node]);

  useEffect(() => {
    const n = props.node;
    n.size = [state.sizeX, state.sizeY, state.sizeZ];
    n.opacity = state.opacity;
    n.sortOrder = state.sortOrder;
    n.angleFade = state.angleFade;
    n.depthFade = state.depthFade;
    n.affects = { ...state.affects };
    n.receivers = state.receivers;
    n.pattern = state.pattern;
    n.radial = state.radial;
  }, [state, props.node]);

  const eventEmitter = useEventBus();
  // Emit from the user handlers, not the apply-effect above, which also runs on mount and would false-dirty
  // on selection. The 'environment' kind marks the tab unsaved (and opens an undo step) without a tree rebuild.
  const update = (patch: Partial<DecalState> | ((prev: DecalState) => Partial<DecalState>)) => {
    setState((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node });
  };
  // The nested groups merge into the PREVIOUS state, so two edits landing in one render cannot drop one.
  const setAffect = (key: keyof DecalAffects, value: boolean) =>
    update((prev) => ({ affects: { ...prev.affects, [key]: value } }));
  const setRadial = (patch: Partial<DecalRadialPattern>) =>
    update((prev) => ({ radial: { ...prev.radial, ...patch } }));

  const radial = state.radial;

  return (
    <Collapsable title='Decal' icon={<DecalIcon />} persistKey='decal'>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Size X' hint={SIZE_HINT}>
            <NumberInput min={0.01} step={0.1} value={state.sizeX} onChange={(v) => update({ sizeX: Math.max(0.01, v) })} />
          </PropertyRow>
          <PropertyRow label='Size Y' hint={SIZE_HINT}>
            <NumberInput min={0.01} step={0.1} value={state.sizeY} onChange={(v) => update({ sizeY: Math.max(0.01, v) })} />
          </PropertyRow>
          <PropertyRow label='Size Z' hint={SIZE_HINT}>
            <NumberInput min={0.01} step={0.1} value={state.sizeZ} onChange={(v) => update({ sizeZ: Math.max(0.01, v) })} />
          </PropertyRow>
          <PropertyRow label='Opacity'>
            <Slider min={0} max={1} step={0.01} value={state.opacity} onChange={(v) => update({ opacity: v })} />
          </PropertyRow>
          <PropertyRow label='Sort order' hint={SORT_HINT}>
            <NumberInput step={1} value={state.sortOrder} onChange={(v) => update({ sortOrder: Math.round(v) })} />
          </PropertyRow>
          <PropertyRow label='Angle fade' hint={ANGLE_FADE_HINT}>
            <Slider min={0} max={1} step={0.01} value={state.angleFade} onChange={(v) => update({ angleFade: v })} />
          </PropertyRow>
          <PropertyRow label='Depth fade' hint={DEPTH_FADE_HINT}>
            <Slider min={0} max={1} step={0.01} value={state.depthFade} onChange={(v) => update({ depthFade: v })} />
          </PropertyRow>
          <PropertyRow label='Affects' labelClassName='align-top pt-1.5'>
            <div className='flex flex-col items-start gap-1'>
              <Toggle label='Albedo' checked={state.affects.albedo} onChange={(v) => setAffect('albedo', v)} />
              <Toggle label='Normal' checked={state.affects.normal} onChange={(v) => setAffect('normal', v)}
                title='Written only when the material has a normal map.' />
              <Toggle label='Roughness / Metal / AO' checked={state.affects.surface} onChange={(v) => setAffect('surface', v)}
                title={SURFACE_HINT} />
              <Toggle label='Emissive' checked={state.affects.emissive} onChange={(v) => setAffect('emissive', v)} />
            </div>
          </PropertyRow>
          <PropertyRow label='Receivers' hint={RECEIVERS_HINT}>
            <Select value={state.receivers} onChange={(e) => update({ receivers: e.target.value as DecalReceivers })}>
              <option value='all'>All surfaces</option>
              <option value='terrain'>Terrain only</option>
            </Select>
          </PropertyRow>
          <PropertyRow label='Pattern' hint={RADIAL_HINT}>
            <Select value={state.pattern} onChange={(e) => update({ pattern: e.target.value as DecalPattern })}>
              <option value='material'>Material</option>
              <option value='radial'>Radial</option>
            </Select>
          </PropertyRow>
        </PropertyTable>

        {state.pattern === 'radial' && (
          <Section title='Radial pattern' className='mt-2' hint={RADIAL_HINT}>
            <PropertyTable columns={['45%', '55%']}>
              <PropertyRow label='Inner colour'>
                <RgbaInput value={radial.innerColor} onChange={(c) => setRadial({ innerColor: c })} />
              </PropertyRow>
              <PropertyRow label='Outer colour'>
                <RgbaInput value={radial.outerColor} onChange={(c) => setRadial({ outerColor: c })} />
              </PropertyRow>
              <PropertyRow label='Shape'>
                <Select value={radial.shape} onChange={(e) => setRadial({ shape: e.target.value as DecalRadialShape })}>
                  <option value='circle'>Circle</option>
                  <option value='square'>Square</option>
                </Select>
              </PropertyRow>
              <PropertyRow label='Curve' hint={CURVE_HINT}>
                <Select value={radial.curve} onChange={(e) => setRadial({ curve: e.target.value as DecalRadialCurve })}>
                  <option value='power'>Power</option>
                  <option value='smooth'>Smooth</option>
                  <option value='linear'>Linear</option>
                  <option value='sphere'>Sphere</option>
                  <option value='tip'>Tip</option>
                </Select>
              </PropertyRow>
              {radial.curve === 'power' ? (
                <PropertyRow label='Exponent' hint='The power curve from rim to centre. 0 is a flat, uniform disc.'>
                  <NumberInput min={0} step={0.1} value={radial.exponent} onChange={(v) => setRadial({ exponent: Math.max(0, v) })} />
                </PropertyRow>
              ) : (
                <PropertyRow label='Falloff' hint='The fraction of the radius the gradient falls over. 0 is a hard edge.'>
                  <Slider min={0} max={1} step={0.01} value={radial.falloff} onChange={(v) => setRadial({ falloff: v })} />
                </PropertyRow>
              )}
              <PropertyRow label='Ring colour' hint='The outline on the rim. Alpha 0 turns it off.'>
                <RgbaInput value={radial.ringColor} onChange={(c) => setRadial({ ringColor: c })} />
              </PropertyRow>
              <PropertyRow label='Ring width (px)' hint='In screen pixels, so the ring stays crisp at any distance.'>
                <NumberInput min={0} step={0.5} value={radial.ringWidthPx} onChange={(v) => setRadial({ ringWidthPx: Math.max(0, v) })} />
              </PropertyRow>
              <PropertyRow label='Emissive' hint='Multiplies the pattern colour into light that is added to the image. 0 is not emissive.'>
                <NumberInput min={0} step={0.1} value={radial.emissive} onChange={(v) => setRadial({ emissive: Math.max(0, v) })} />
              </PropertyRow>
            </PropertyTable>
          </Section>
        )}

        <Hint className='mt-2'>
          Surface decals do not show on Default (Blinn-Phong) or Cel materials, which are shaded forward — only emissive does.
        </Hint>
      </div>
    </Collapsable>
  );
}
