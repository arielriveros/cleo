import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { Button, Collapsable, PresetMenu } from '@cleo/app-kit/ui';
import { FX_SCENE_SPECS, normaliseFx, type FxParams } from '../fxParams';
import { applySceneValues, SCENE_PRESETS, SCENE_SECTION_PRESETS, type SceneValues, type SectionPreset } from '../fxPresets';
import { newBody, SCENE_SCHEMA, type FxBody, type FxBodyKind, type FxScene } from '../fxScene';
import type { FxSelection } from './FxGizmos';

// The LEFT dock panel: the scene's composition -- everything about where and how the effect is staged.
// The outliner, the simulation region (its size and where it stands), the sun (the one light the effect
// is shaded with, preview and bake alike), sky, fire light, wind, ground, bodies, and the preview's
// rendering. The effect itself is the right panel's.
//
// Most of it is the stage (FxScene, preview only). The region's size, the sun's direction and the preview
// quality are effect values (FxParams: the bake needs the first two), edited here because they are the
// scene's composition.

const BODY_KINDS: { kind: FxBodyKind; label: string }[] = [
  { kind: 'sphere', label: 'Sphere' }, { kind: 'box', label: 'Box' }, { kind: 'capsule', label: 'Capsule' }, { kind: 'wall', label: 'Wall' },
];

const BODY_SCHEMA: GenericParamSpec[] = [
  { key: 'visible', label: 'In the scene', kind: 'bool' },
  { key: 'position', label: 'Position', kind: 'vec3', unit: 'm' },
  { key: 'size', label: 'Size', kind: 'vec3', unit: 'm' },
  { key: 'yaw', label: 'Turn', kind: 'float', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'pitch', label: 'Tilt', kind: 'float', min: -90, max: 90, step: 1, unit: '°' },
];

const REGION_SCHEMA: GenericParamSpec[] = [
  { key: 'regionOffset', label: 'Region position', kind: 'vec3', unit: 'm' },
];

interface Props {
  scene: FxScene;
  setScene: (s: FxScene) => void;
  params: FxParams;
  setParams: (p: FxParams) => void;
  selection: FxSelection;
  select: (s: FxSelection) => void;
}

export function ScenePanel({ scene, setScene, params, setParams, selection, select }: Props) {
  const isSel = (s: FxSelection) => JSON.stringify(s) === JSON.stringify(selection);
  const pick = (s: FxSelection) => (isSel(s) ? select(null) : select(s));
  const rowClass = (on: boolean) => `w-full text-left px-1.5 py-0.5 rounded text-ui-sm ${on ? 'bg-primary/25 text-fg' : 'text-muted hover:bg-surface-raised'}`;
  const sceneValues = scene as unknown as Record<string, unknown>;
  const paramValues = params as unknown as Record<string, unknown>;
  const region = normaliseFx(params).regionSize;
  const setBody = (id: string, patch: Partial<FxBody>) =>
    setScene({ ...scene, bodies: scene.bodies.map(b => (b.id === id ? sanitizeBody({ ...b, ...patch }) : b)) });

  /** A scene-side preset touches the stage and/or the effect's scene-side values. */
  const apply = (v: SceneValues, replaceBodies: boolean) => {
    const next = applySceneValues(v, scene, params, region, replaceBodies);
    setScene(next.scene);
    if (v.params) setParams(next.params);
  };
  const presetMenu = (title: string) => {
    const presets = SCENE_SECTION_PRESETS[title];
    return presets ? <PresetMenu presets={presets} onApply={(p: SectionPreset<SceneValues>) => apply(p.values, false)} /> : undefined;
  };
  /** A section's effect-side fields (drawn first) and stage fields. */
  const section = (title: string, effectSpecs: GenericParamSpec[] | undefined, stageSpecs: GenericParamSpec[] | undefined, extra?: React.ReactNode) => (
    <Collapsable key={title} title={title} persistKey={`cleo_creator_fx_scene_${title}`} right={presetMenu(title)}>
      {effectSpecs && <ParamForm schema={effectSpecs} values={paramValues} onChange={patch => setParams({ ...params, ...(patch as Partial<FxParams>) })} />}
      {stageSpecs && <ParamForm schema={stageSpecs} values={sceneValues} onChange={patch => setScene({ ...scene, ...(patch as Partial<FxScene>) })} />}
      {extra}
    </Collapsable>
  );
  const stage = (title: string) => SCENE_SCHEMA.find(g => g.title === title)?.specs;

  return (
    <div className='p-2 overflow-auto h-full'>
      <div className='flex items-center justify-between pb-1'>
        <span className='text-ui-sm text-muted'>Scene</span>
        <PresetMenu label='Scene presets' presets={SCENE_PRESETS} onApply={(p: SectionPreset<SceneValues>) => apply(p.values, true)} />
      </div>
      <Collapsable title='Select' persistKey='cleo_creator_fx_scene_Select'>
        <div className='flex flex-col gap-0.5 py-1'>
          <button type='button' className={rowClass(isSel({ kind: 'region' }))} onClick={() => pick({ kind: 'region' })}>Simulation region</button>
          <button type='button' className={rowClass(isSel({ kind: 'emitter' }))} onClick={() => pick({ kind: 'emitter' })}>Emitter</button>
          {scene.bodies.map((b, i) => (
            <button key={b.id} type='button' className={rowClass(isSel({ kind: 'body', id: b.id }))} onClick={() => pick({ kind: 'body', id: b.id })}>
              {b.kind[0].toUpperCase() + b.kind.slice(1)} {i + 1}
            </button>
          ))}
        </div>
        <div className='text-dim text-ui-xs pb-1'>Or click it in the viewport. W / E / R: move, rotate, scale. F frames it.</div>
      </Collapsable>
      {section('Region', FX_SCENE_SPECS.Region, REGION_SCHEMA)}
      {section('Sun & sky', FX_SCENE_SPECS['Sun & sky'], stage('Sun & sky'))}
      {section('Fire light', undefined, stage('Fire light'))}
      {section('Wind', undefined, stage('Wind'))}
      {section('Bodies', undefined, undefined, <>
        <div className='flex flex-wrap gap-1 py-1'>
          {BODY_KINDS.map(k => (
            <Button key={k.kind} size='sm' onClick={() => {
              const fresh = newBody(k.kind, region[1]);
              // Placed relative to the region, wherever it stands.
              const o = scene.regionOffset ?? [0, 0, 0];
              const body = { ...fresh, position: [fresh.position[0] + o[0], fresh.position[1] + o[1], fresh.position[2] + o[2]] as [number, number, number] };
              setScene({ ...scene, bodies: [...scene.bodies, body] });
              select({ kind: 'body', id: body.id });
            }}>
              + {k.label}
            </Button>
          ))}
        </div>
        {scene.bodies.length === 0 && <div className='text-dim text-ui-xs py-1'>No bodies. The gas flows around any you add.</div>}
        {scene.bodies.map((b, i) => (
          <div key={b.id} className='border-t border-border pt-1 mt-1'>
            <div className='flex items-center justify-between'>
              <button type='button' className={rowClass(isSel({ kind: 'body', id: b.id }))} onClick={() => pick({ kind: 'body', id: b.id })}>
                {b.kind[0].toUpperCase() + b.kind.slice(1)} {i + 1}
              </button>
              <Button size='sm' variant='ghost' onClick={() => setScene({ ...scene, bodies: scene.bodies.filter(x => x.id !== b.id) })}>Remove</Button>
            </div>
            <ParamForm schema={BODY_SCHEMA} values={b as unknown as Record<string, unknown>} onChange={patch => setBody(b.id, patch as Partial<FxBody>)} />
          </div>
        ))}
      </>)}
      {section('Rendering', FX_SCENE_SPECS.Rendering, stage('Rendering'))}
    </div>
  );
}

/** Sizes stay positive and finite: a zero or negative extent would voxelise to nothing or everything. */
function sanitizeBody(b: FxBody): FxBody {
  const pos = (v: number) => (Number.isFinite(v) ? Math.max(0.02, v) : 0.5);
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  return {
    ...b,
    size: [pos(b.size[0]), pos(b.size[1]), pos(b.size[2])],
    position: [fin(b.position[0]), fin(b.position[1]), fin(b.position[2])],
  };
}
