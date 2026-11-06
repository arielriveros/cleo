import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { Collapsable, Toggle } from '@cleo/app-kit/ui';
import { PanelBody } from '../../app/workspace';
import { EXPORT_MASKS } from '../exportWorld';
import { RESOLUTIONS, SPLAT_RESOLUTIONS, type WorldDoc, type WorldOutputSettings } from '../worldDoc';

// The Export tab: what the World writes, in which standard layouts. Everything here changes the files
// (and so the export hash an editor re-applies on); nothing here changes the preview.

const HEIGHT_SCHEMA: GenericParamSpec[] = [
  { key: 'resolution', label: 'Resolution', kind: 'enum', options: RESOLUTIONS.map(r => ({ value: String(r), label: `${r} x ${r}` })), hint: 'Height samples per side (2^n + 1, Unity\'s terrain sizes). The live preview runs smaller.' },
  { key: 'exr', label: 'OpenEXR heights', kind: 'bool', hint: '32-bit float heights in metres, beside the 16-bit PNG and RAW.' },
];

const SURFACE_SCHEMA: GenericParamSpec[] = [
  { key: 'splatResolution', label: 'Splat resolution', kind: 'enum', options: SPLAT_RESOLUTIONS.map(r => ({ value: String(r), label: `${r} x ${r}` })), hint: 'Texels per side of the splat and weight maps.' },
  { key: 'splat', label: 'RGBA splatmaps', kind: 'bool', hint: 'Four surfaces\' normalised weights per image (Unity alphamaps, Godot, custom shaders).' },
  { key: 'weightmaps', label: 'Weight maps', kind: 'bool', hint: 'One grayscale weight map per surface (Unreal weight-blended layers, Gaea, Blender).' },
];

const PACKAGE_SCHEMA: GenericParamSpec[] = [
  { key: 'masks16', label: '16-bit masks', kind: 'bool', hint: 'Data masks at 16 bits rather than 8.' },
  { key: 'zip', label: 'One zip', kind: 'bool', hint: 'Download a single zip rather than separate files.' },
];

export function ExportPanel({ doc, setDoc }: { doc: WorldDoc; setDoc: (d: WorldDoc) => void }) {
  const out = doc.output;
  const set = (patch: Partial<WorldOutputSettings>) => setDoc({ ...doc, output: { ...out, ...patch } });
  const enabled = doc.surfaces.filter((s, i) => i === 0 || s.enabled).length;
  return (
    <PanelBody>
      <Collapsable title='Heightmap' persistKey='cleo_creator_world_export_height'>
        <ParamForm schema={HEIGHT_SCHEMA} values={{ resolution: String(doc.settings.resolution), exr: out.exr }}
                   onChange={patch => {
                     if (patch.resolution !== undefined) setDoc({ ...doc, settings: { ...doc.settings, resolution: Number(patch.resolution) } });
                     if (patch.exr !== undefined) set({ exr: !!patch.exr });
                   }} />
        <div className='text-ui-xs text-dim mt-1'>Always: a 16-bit greyscale PNG and a headerless 16-bit RAW, with the height range in the manifest.</div>
      </Collapsable>
      <Collapsable title='Surface maps' persistKey='cleo_creator_world_export_surfaces'>
        <ParamForm schema={SURFACE_SCHEMA} values={{ ...out, splatResolution: String(out.splatResolution) } as unknown as Record<string, unknown>}
                   onChange={patch => set({ ...patch, ...(patch.splatResolution !== undefined ? { splatResolution: Number(patch.splatResolution) } : {}) } as Partial<WorldOutputSettings>)} />
        <div className='text-ui-xs text-dim mt-1'>
          {enabled} surfaces → {Math.ceil(enabled / 4)} splatmap{enabled > 4 ? 's' : ''}. Weights sum to 255 at every texel, so any engine can blend them in its own layer order.
        </div>
      </Collapsable>
      <Collapsable title='Data masks' persistKey='cleo_creator_world_export_masks'>
        <div className='grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5'>
          {EXPORT_MASKS.map(m => (
            <label key={m.id} className='contents'>
              <span className='text-ui text-fg' title={m.meaning}>{m.label}</span>
              <Toggle checked={out.masks.includes(m.id)} onChange={v => set({ masks: v ? [...out.masks, m.id] : out.masks.filter(x => x !== m.id) })} />
            </label>
          ))}
        </div>
      </Collapsable>
      <Collapsable title='Package' persistKey='cleo_creator_world_export_package'>
        <ParamForm schema={PACKAGE_SCHEMA} values={out as unknown as Record<string, unknown>} onChange={patch => set(patch as Partial<WorldOutputSettings>)} />
        <div className='text-ui-xs text-dim mt-1'>The manifest (.json) names every file: the height range, each surface's splat channel and weight map, the sea level and the lakes.</div>
      </Collapsable>
    </PanelBody>
  );
}
