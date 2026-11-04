import { FloorSection } from '../../app/floor/FloorSection';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { Button, Collapsable, PresetMenu } from '@cleo/app-kit/ui';
import { ListRow, PanelBody, PanelHeader, StageSection } from '../../app/workspace';
import { FX_SCENE_SPECS, normaliseFx, type FxParams } from '../fxParams';
import { applySceneValues, SCENE_PRESETS, SCENE_SECTION_PRESETS, type SceneValues, type SectionPreset } from '../fxPresets';
import { newBody, SCENE_SCHEMA, type FxBody, type FxBodyKind, type FxScene, type Spray } from '../fxScene';
import { aimVector, sourceCenter } from '../liquidCpu';
import type { FxSelection } from './FxGizmos';

// The LEFT dock panel: what is in the scene -- the outliner, the simulation region (its size and where it
// stands), the bodies, and how the preview renders. The light on it (sun, sky, exposure), the wind and the
// fire light are the viewport's Stage menu, as in the Foliage Creator: `FxStageSections` below. The effect
// itself is the right panel's.
//
// Most of it is the stage (FxScene, preview only). The region's size, the sun's direction and the preview
// quality are effect values (FxParams: the bake needs the first two), edited here because they are the
// scene's composition.

const BODY_KINDS: { kind: FxBodyKind; label: string }[] = [
  { kind: 'sphere', label: 'Sphere' }, { kind: 'box', label: 'Box' }, { kind: 'capsule', label: 'Capsule' }, { kind: 'wall', label: 'Wall' },
];

// A body's place, size, turn and tilt are its gizmos' (move, scale, rotate in the viewport): only whether it
// is in the scene is a field.
const BODY_SCHEMA: GenericParamSpec[] = [
  { key: 'visible', label: 'In the scene', kind: 'bool' },
];

interface Props {
  scene: FxScene;
  setScene: (s: FxScene) => void;
  params: FxParams;
  setParams: (p: FxParams) => void;
  selection: FxSelection;
  select: (s: FxSelection) => void;
}

/** A liquid's source and aim, relative to the centre of the region's floor: where a new body goes. */
function sprayOf(params: FxParams): Spray | undefined {
  const p = normaliseFx(params);
  if (p.medium !== 'liquid') return undefined;
  const c = sourceCenter(p);
  return { source: [c.x - p.regionSize[0] / 2, c.y, c.z - p.regionSize[2] / 2], aim: aimVector(p) };
}

/** A section's presets: they touch the stage and / or the effect's scene-side values (the sun's direction). */
function scenePresetMenu(title: string, apply: (v: SceneValues) => void) {
  const presets = SCENE_SECTION_PRESETS[title];
  return presets ? <PresetMenu presets={presets} onApply={(p: SectionPreset<SceneValues>) => apply(p.values)} /> : undefined;
}

/**
 * The FX Creator's sections of the viewport's Stage menu, after its Show switches and Sun: the light
 * (illuminance, colour, ambient, exposure; the sun presets as times of day), the wind while it blows, and
 * a gas's fire light -- each with its presets.
 */
export function FxStageSections({ scene, setScene, params, setParams }: Omit<Props, 'selection' | 'select'>) {
  const region = normaliseFx(params).regionSize;
  const values = scene as unknown as Record<string, unknown>;
  const patch = (p: Record<string, unknown>) => setScene({ ...scene, ...(p as Partial<FxScene>) });
  const apply = (v: SceneValues) => {
    const next = applySceneValues(v, scene, params, region, false);
    setScene(next.scene);
    if (v.params) setParams(next.params);
  };
  const specs = (title: string) => SCENE_SCHEMA.find(g => g.title === title)?.specs ?? [];
  return (<>
    <StageSection title='Light' right={scenePresetMenu('Sun & sky', apply)}>
      <ParamForm schema={specs('Sun & sky')} values={values} onChange={patch} />
    </StageSection>
    {scene.wind && (
      <StageSection title='Wind' right={scenePresetMenu('Wind', apply)}>
        <ParamForm schema={specs('Wind')} values={values} onChange={patch} />
      </StageSection>
    )}
    <FloorSection set={scene.floorSet} tile={scene.floorTile} onChange={patch} />
    {params.medium !== 'liquid' && (
      <StageSection title='Fire light' right={scenePresetMenu('Fire light', apply)}>
        <ParamForm schema={specs('Fire light')} values={values} onChange={patch} />
      </StageSection>
    )}
  </>);
}

export function ScenePanel({ scene, setScene, params, setParams, selection, select }: Props) {
  const isSel = (s: FxSelection) => JSON.stringify(s) === JSON.stringify(selection);
  const pick = (s: FxSelection) => (isSel(s) ? select(null) : select(s));
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
    <PanelBody>
      <PanelHeader kind='Scene' name={`${scene.bodies.length} ${scene.bodies.length === 1 ? 'body' : 'bodies'}`} presetLabel='Scene presets'
                   presets={SCENE_PRESETS} onPreset={(p: SectionPreset<SceneValues>) => apply(p.values, true)} />
      <Collapsable title='Select' persistKey='cleo_creator_fx_scene_Select'>
        <div className='flex flex-col gap-0.5 py-1'>
          <ListRow selected={isSel({ kind: 'region' })} onClick={() => pick({ kind: 'region' })}>Simulation region</ListRow>
          <ListRow selected={isSel({ kind: 'emitter' })} onClick={() => pick({ kind: 'emitter' })}>Emitter</ListRow>
          {scene.bodies.map((b, i) => (
            <ListRow key={b.id} selected={isSel({ kind: 'body', id: b.id })} onClick={() => pick({ kind: 'body', id: b.id })}>
              {b.kind[0].toUpperCase() + b.kind.slice(1)} {i + 1}
            </ListRow>
          ))}
        </div>
        <div className='text-dim text-ui-xs pb-1'>Or click it in the viewport. W / E / R: move, rotate, scale. F frames it.</div>
      </Collapsable>
      {section('Bodies', undefined, undefined, <>
        <div className='flex flex-wrap gap-1 py-1'>
          {BODY_KINDS.map(k => (
            <Button key={k.kind} size='sm' onClick={() => {
              // A liquid's new body goes in its path, so it shows at once what it changes.
              const fresh = newBody(k.kind, region, sprayOf(params));
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
        {scene.bodies.length === 0 && <div className='text-dim text-ui-xs py-1'>No bodies. The effect flows around any you add, in the preview.</div>}
        {scene.bodies.map((b, i) => (
          <div key={b.id} className='border-t border-border pt-1 mt-1'>
            <ListRow selected={isSel({ kind: 'body', id: b.id })} onClick={() => pick({ kind: 'body', id: b.id })}
                     actions={<Button size='sm' variant='ghost' onClick={() => setScene({ ...scene, bodies: scene.bodies.filter(x => x.id !== b.id) })}>Remove</Button>}>
              {b.kind[0].toUpperCase() + b.kind.slice(1)} {i + 1}
            </ListRow>
            <ParamForm schema={BODY_SCHEMA} values={b as unknown as Record<string, unknown>} onChange={patch => setBody(b.id, patch as Partial<FxBody>)} />
          </div>
        ))}
      </>)}
      {section('Rendering', FX_SCENE_SPECS.Rendering, stage('Rendering'))}
    </PanelBody>
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
