import type { ReactNode } from 'react';
import { DocScope } from '../docs/DocScope';
import { ColorInput } from '../ui/ColorInput';
import { Select } from '../ui/inputs';
import { Section } from '../ui/Panel';
import { PropertyRow, PropertyTable } from '../ui/PropertyTable';
import { Slider } from '../ui/Slider';

// The PBR material's fields, shared by the Editor's material inspector and the Creators' material panels.
//
// Values in, patches out, like ParamForm: the caller decides what a change means (the Editor writes a live
// engine Material and marks the scene dirty; the Foliage Creator rebuilds its asset). A field whose value
// is `undefined` is not drawn, so a caller shows only what its material carries. Labels and section titles
// are the material editor's, documented once in docs/editor/models-and-materials.md: the sections scope
// themselves there, whichever app mounts them.

export type Rgb = [number, number, number];
export type WindRole = 'plant' | 'leaves';

export interface MaterialFieldValues {
  baseColor?: Rgb;
  metallic?: number;
  roughness?: number;
  /** Dielectric specular level, 0.5 neutral. */
  reflectance?: number;
  translucency?: number;
  /** The colour light comes through in (back-lit leaves go yellow-green), and how far it blends toward it. */
  translucencyColor?: Rgb;
  translucencyBlend?: number;
  opacity?: number;
  emissive?: Rgb;
  emissiveIntensity?: number;
  /** How much the camera's exposure dims the emission (Editor only). */
  emissiveWeight?: number;
  alphaCutoff?: number;
  windStrength?: number;
  windStiffness?: number;
  windRole?: WindRole;
  windFlutter?: number;
}

export type MaterialPatch = Partial<MaterialFieldValues>;

interface SectionProps {
  value: MaterialFieldValues;
  onChange: (patch: MaterialPatch) => void;
}

const DOC_PAGE = 'editor/models-and-materials';
const hex = (c: Rgb | undefined) =>
  '#' + (c ?? [0, 0, 0]).slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const isWhite = (c: Rgb | undefined) => !!c && c.every(v => v >= 0.999);
const has = (v: unknown) => v !== undefined;

/** The last drawn row of a table has no divider below it. */
function rows(entries: [boolean, (divider: boolean) => ReactNode][]): ReactNode[] {
  const shown = entries.filter(([on]) => on);
  return shown.map(([, row], i) => row(i < shown.length - 1));
}

/**
 * PBR Properties: base colour, metallic, roughness, reflectance, translucency, opacity and emission.
 * `tintsTexture` warns that a non-white base colour multiplies the base colour texture.
 */
export function PbrPropertiesSection({ value: v, onChange, tintsTexture = false }: SectionProps & { tintsTexture?: boolean }) {
  return (
    <DocScope page={DOC_PAGE}>
      <Section title='Properties'>
        <PropertyTable columns={['40%', '60%']}>
          {rows([
            [has(v.baseColor), d => <PropertyRow key='baseColor' label='Base Color' divider={d}><ColorInput color={hex(v.baseColor)} onChange={c => onChange({ baseColor: c })} /></PropertyRow>],
            // The colour MULTIPLIES a base colour texture: a grey tint caps a white texture (snow) at that
            // grey, which reads as a lighting problem rather than as this setting.
            [tintsTexture && has(v.baseColor) && !isWhite(v.baseColor), d => (
              <PropertyRow key='tint' label='' divider={d}>
                <span className='text-ui-xs text-warning' title='The base colour multiplies the texture'>
                  Tints the texture —{' '}
                  <button type='button' className='underline' onClick={() => onChange({ baseColor: [1, 1, 1] })}>use white</button>
                  {' '}to show it as authored.
                </span>
              </PropertyRow>
            )],
            [has(v.metallic), d => <PropertyRow key='metallic' label='Metallic' divider={d}><Slider min={0} max={1} step={0.01} value={v.metallic!} onChange={x => onChange({ metallic: x })} /></PropertyRow>],
            [has(v.roughness), d => <PropertyRow key='roughness' label='Roughness' divider={d}><Slider min={0} max={1} step={0.01} value={v.roughness!} onChange={x => onChange({ roughness: x })} /></PropertyRow>],
            // Dielectric specular level. 0.5 reproduces the fixed 4% reflectance every non-metal used to
            // have; water sits near 0.35, skin near 0.42, gemstones 0.55-0.7. No effect at metallic 1.
            [has(v.reflectance), d => <PropertyRow key='reflectance' label='Reflectance' divider={d}><Slider min={0} max={1} step={0.01} value={v.reflectance!} onChange={x => onChange({ reflectance: x })} /></PropertyRow>],
            // Thin-surface light transmission (leaves, grass, paper). Stored in the G-buffer as a negative
            // metallic, so a translucent surface is always shaded as a dielectric.
            [has(v.translucency), d => <PropertyRow key='translucency' label='Translucency' divider={d}><Slider min={0} max={1} step={0.01} value={v.translucency!} onChange={x => onChange({ translucency: x })} /></PropertyRow>],
            // The transmitted light's colour: a back-lit leaf glows yellow-green, an autumn one orange. Hue
            // only -- matched to the surface's brightness -- so Translucency stays the intensity.
            [has(v.translucencyColor) && (v.translucency ?? 0) > 0, d => <PropertyRow key='translucencyColor' label='Translucency colour' divider={d}><ColorInput color={hex(v.translucencyColor)} onChange={c => onChange({ translucencyColor: c })} /></PropertyRow>],
            [has(v.translucencyBlend) && (v.translucency ?? 0) > 0, d => <PropertyRow key='translucencyBlend' label='Colour blend' divider={d}><Slider min={0} max={1} step={0.01} value={v.translucencyBlend!} onChange={x => onChange({ translucencyBlend: x })} /></PropertyRow>],
            [has(v.opacity), d => <PropertyRow key='opacity' label='Opacity' divider={d}><Slider min={0} max={1} step={0.01} value={v.opacity!} onChange={x => onChange({ opacity: x })} /></PropertyRow>],
            [has(v.emissive), d => <PropertyRow key='emissive' label='Emissive' divider={d}><ColorInput color={hex(v.emissive)} onChange={c => onChange({ emissive: c })} /></PropertyRow>],
            // The colour is a hex picker and cannot exceed 1 per channel, below where bloom starts. The
            // colour is the hue; this is how hot. Above ~2 an emissive surface starts to bloom.
            [has(v.emissiveIntensity), d => <PropertyRow key='emissiveIntensity' label='Emissive power' divider={d}><Slider min={0} max={20} step={0.1} value={v.emissiveIntensity!} onChange={x => onChange({ emissiveIntensity: x })} /></PropertyRow>],
            [has(v.emissiveWeight), d => <PropertyRow key='emissiveWeight' label='Exposure weight' divider={d}><Slider min={0} max={1} step={0.05} value={v.emissiveWeight!} onChange={x => onChange({ emissiveWeight: x })} /></PropertyRow>],
          ])}
        </PropertyTable>
      </Section>
    </DocScope>
  );
}

/** Cutout: the alpha threshold, with an optional mask slot beside it. */
export function CutoutSection({ value: v, onChange, mask }: SectionProps & { mask?: ReactNode }) {
  if (!has(v.alphaCutoff)) return null;
  return (
    <DocScope page={DOC_PAGE}>
      <Section title='Cutout'>
        <PropertyTable columns={['40%', '60%']}>
          {/* The mask is read from RED (or the base colour's alpha). 0 disables the cutout entirely;
              anything above it discards where the mask falls below. */}
          <PropertyRow label='Alpha cutoff' divider={!!mask}>
            <Slider min={0} max={1} step={0.01} value={v.alphaCutoff!} onChange={x => onChange({ alphaCutoff: x })} />
          </PropertyRow>
          {mask && <PropertyRow label='Mask' divider={false}>{mask}</PropertyRow>}
        </PropertyTable>
      </Section>
    </DocScope>
  );
}

/** Wind: how a plant wearing the material sways in the scene's Wind. Read by instanced foliage only. */
export function WindSection({ value: v, onChange }: SectionProps) {
  if (!has(v.windStrength)) return null;
  const role: WindRole = v.windRole === 'leaves' ? 'leaves' : 'plant';
  return (
    <DocScope page={DOC_PAGE}>
      <Section title='Wind'>
        <PropertyTable columns={['40%', '60%']}>
          {/* A tree's bark and needles bend as one: the strongest of its materials sets the lean. */}
          <PropertyRow label='Strength' hint='How far a plant leans at full gust, as a fraction of its height. 0 = never moves. Grass ~0.3, trees ~0.08.'>
            <Slider min={0} max={1} step={0.01} value={v.windStrength!} onChange={x => onChange({ windStrength: x })} />
          </PropertyRow>
          <PropertyRow label='Stiffness' hint='Higher is slower and steadier: grass ~0.6, a young tree ~1.5, an old trunk ~3.'>
            <Slider min={0.1} max={4} step={0.05} value={v.windStiffness ?? 1} onChange={x => onChange({ windStiffness: x })} />
          </PropertyRow>
          <PropertyRow label='Moves as' divider={role === 'leaves'} hint='Bark: Whole plant — it rides the plant&#39;s sway rigidly, like a trunk. Needles and leaves: Leaves — they follow the trunk and add their own sprig sway and flutter, more toward the outside of the canopy, so they stay on their branches.'>
            <Select value={role} onChange={e => onChange({ windRole: e.target.value === 'leaves' ? 'leaves' : 'plant', windFlutter: v.windFlutter ?? 0.5 })}>
              <option value='plant'>Whole plant</option>
              <option value='leaves'>Leaves</option>
            </Select>
          </PropertyRow>
          {role === 'leaves' && (
            <PropertyRow label='Flutter' divider={false} hint='How lively the leaves are on top of the plant&#39;s sway. 0 = they ride it rigidly.'>
              <Slider min={0} max={1} step={0.01} value={v.windFlutter ?? 0.5} onChange={x => onChange({ windFlutter: x })} />
            </PropertyRow>
          )}
        </PropertyTable>
      </Section>
    </DocScope>
  );
}

export interface MaterialFieldsProps extends SectionProps {
  /** Drawn as the Textures section, between Properties and Cutout. */
  textures?: ReactNode;
  /** Drawn beside Alpha cutoff. */
  mask?: ReactNode;
  /** Whether a base colour texture is assigned (warns when the colour tints it). */
  tintsTexture?: boolean;
}

/** A PBR material's whole panel: Properties, Textures, Cutout, Wind. */
export function MaterialFields({ value, onChange, textures, mask, tintsTexture }: MaterialFieldsProps) {
  return (<>
    <PbrPropertiesSection value={value} onChange={onChange} tintsTexture={tintsTexture} />
    {textures && <DocScope page={DOC_PAGE}><Section title='Textures'>{textures}</Section></DocScope>}
    <CutoutSection value={value} onChange={onChange} mask={mask} />
    <WindSection value={value} onChange={onChange} />
  </>);
}

export default MaterialFields;
