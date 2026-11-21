import React, { useState } from 'react';
import { CameraNode, resolvePostChain, materialIndexOf, rigOfCamera } from 'cleo';
import type { PostChainEntry, PostEffectId } from 'cleo';
import Collapsable from '@cleo/app-kit/ui/Collapsable';
import { PropertyTable, PropertyRow, Select, Button, Toggle, Hint, cn, valueClass } from '@cleo/app-kit/ui';
import DeclaredSections, { useNodeTick } from '../../properties/DeclaredSections';
import { CameraIcon, MaterialIcon } from '../sectionIcons';
import {
  BloomIcon, ChromaticIcon, DepthOfFieldIcon, FilmGrainIcon, GodRaysIcon, LensFlareIcon, PostEffectIcon, VignetteIcon,
} from '../effectIcons';
import { useAssetDrop } from '../../../utils/useAssetDrop';
import { useEventBus } from '../../EventBusContext';
import { useAssetLibrary } from '../../AssetLibraryContext';
import { useEditorSessions } from '../../EditorSessionsContext';
import { getScreenMaterialIds, applyScreenMaterials, isScreenMaterialAsset } from '../../../utils/screenMaterials';

// Display names for the built-in effects. The chain stores ids; these never reach a saved file.
const BUILTIN_LABELS: Record<string, string> = {
  depthOfField: 'Depth of Field',
  godRays: 'God Rays',
  bloom: 'Bloom',
  lensFlare: 'Lens Flare',
  chromatic: 'Chromatic Aberration',
  vignette: 'Vignette',
  filmGrain: 'Film Grain',
};

const BUILTIN_ICONS: Record<string, (props: React.SVGProps<SVGSVGElement>) => React.ReactElement> = {
  depthOfField: DepthOfFieldIcon,
  godRays: GodRaysIcon,
  bloom: BloomIcon,
  lensFlare: LensFlareIcon,
  chromatic: ChromaticIcon,
  vignette: VignetteIcon,
  filmGrain: FilmGrainIcon,
};

export default function CameraEditor(props: { node: CameraNode }) {
  useNodeTick(props.node);
  // A rig that controls the FOV owns it: the field shows the rig's value instead (a slider that did nothing would
  // read as a bug).
  const rig = rigOfCamera(props.node);
  const fovDrivenByRig = props.node.camera.type === 'perspective' && !!rig?.fovEnabled;
  return (
    <>
      <Collapsable title='Camera' icon={<CameraIcon />} persistKey='camera'>
        <div className='w-full p-2'>
          {fovDrivenByRig && <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Field of View'>
              <span className={cn(valueClass, 'tabular-nums')}>{rig!.fov.toFixed(1)}</span>
              <Hint>Driven by the Camera Rig.</Hint>
            </PropertyRow>
          </PropertyTable>}
          <DeclaredSections node={props.node} of={CameraNode} />
        </div>
      </Collapsable>
      <PostChainList node={props.node} />
    </>
  );
}

function PostChainList(props: { node: CameraNode }) {
  const { materials } = useAssetLibrary();
  const { enterMaterialEditor } = useEditorSessions();
  const eventEmitter = useEventBus();
  const [, force] = useState(0); // node mutations don't trigger React; bump to re-read the list

  const ids = getScreenMaterialIds(props.node);
  const screenAssets = materials.filter(isScreenMaterialAsset);
  // Always the RESOLVED chain, never the raw field: a camera nobody has reordered stores null, and the
  // resolver is what turns that into the order the renderer will actually run. Editing any row is what
  // first gives the camera a chain of its own.
  const chain = resolvePostChain(props.node.postChain, ids.length);

  const commitChain = (next: PostChainEntry[]) => {
    // `isDefaultChain` is applied at serialization, so putting the rows back in default order clears
    // the override rather than banking a redundant one.
    props.node.postChain = next;
    eventEmitter.emit('SCENE_CHANGED');
    force((x) => x + 1);
  };

  const move = (index: number, dir: -1 | 1) => {
    const next = [...chain];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    commitChain(next);
  };

  const setEnabled = (index: number, enabled: boolean) =>
    commitChain(chain.map((e, i) => (i === index ? { ...e, enabled } : e)));

  const resetChain = () => {
    props.node.postChain = null;
    eventEmitter.emit('SCENE_CHANGED');
    force((x) => x + 1);
  };

  // Rebuilding the material list renumbers every `material:N`, so the chain has to be rewritten in the
  // same breath: the ids are positional (a CustomMaterial has no stable id of its own) and a chain left
  // pointing at the old positions would silently reorder the user's passes.
  const commitMaterials = (nextIds: string[]) => {
    const assets = nextIds
      .map((id) => materials.find((m) => m.id === id))
      .filter((a): a is NonNullable<typeof a> => !!a);
    const remapped = chain
      .map((entry) => {
        const at = materialIndexOf(entry.effect);
        if (at === null) return entry; // a built-in, unaffected by the renumbering
        const moved = nextIds.indexOf(ids[at]);   // -1 once this material has been removed
        return moved === -1 ? null : { ...entry, effect: `material:${moved}` as PostEffectId };
      })
      .filter((e): e is PostChainEntry => !!e);
    applyScreenMaterials(props.node, assets);
    props.node.postChain = remapped;
    eventEmitter.emit('SCENE_CHANGED');
    force((x) => x + 1);
  };

  const addMaterial = (id: string) => { if (id && !ids.includes(id)) commitMaterials([...ids, id]); };
  const removeMaterial = (index: number) => commitMaterials(ids.filter((_, i) => i !== index));

  // Only a SCREEN material may be dropped here; any other material asset is ignored.
  const { dragOver, dropProps } = useAssetDrop('text/cleo-material', id => {
    if (materials.find((m) => m.id === id && isScreenMaterialAsset(m))) addMaterial(id);
  });

  return (
    <Collapsable title='Post-Processing' icon={<MaterialIcon />} persistKey='cameraPostChain'>
      <div className={`w-full p-2 flex flex-col gap-2 ${dragOver ? 'bg-border/30' : ''}`} {...dropProps}>
        {chain.map((entry, i) => {
          const materialIndex = materialIndexOf(entry.effect);
          const asset = materialIndex === null ? undefined : materials.find((m) => m.id === ids[materialIndex]);
          return (
            <div key={`${entry.effect}-${i}`} className='flex items-center gap-2 p-2 bg-control border border-border rounded'>
              {materialIndex === null ? (
                <>
                  <div className='w-[32px] h-[32px] rounded overflow-hidden bg-surface-raised flex items-center justify-center shrink-0'>
                    {React.createElement(BUILTIN_ICONS[entry.effect] ?? PostEffectIcon, { className: 'w-5 h-5 text-highlight' })}
                  </div>
                  <span className={cn(valueClass, 'truncate flex-1')}>{BUILTIN_LABELS[entry.effect] ?? entry.effect}</span>
                </>
              ) : asset ? (
                <>
                  <div className='w-[32px] h-[32px] rounded overflow-hidden bg-surface-raised flex items-center justify-center shrink-0'>
                    {asset.thumbnail
                      ? <img src={asset.thumbnail} className='w-full h-full object-cover' alt={asset.name} draggable={false} />
                      : <span className='inline-flex w-5 h-5 text-dim [&>svg]:w-full [&>svg]:h-full'><MaterialIcon /></span>}
                  </div>
                  <span className={cn(valueClass, 'truncate flex-1')} title={asset.name}>{asset.name}</span>
                  <Button variant='ghost' size='icon' className='text-highlight' title='Edit this material' onClick={() => enterMaterialEditor(asset.id)}>✎</Button>
                </>
              ) : (
                <span className={cn(valueClass, 'truncate flex-1 text-warning')} title={ids[materialIndex]}>Missing material asset</span>
              )}
              <Toggle checked={entry.enabled} onChange={(c) => setEnabled(i, c)}
                title={entry.enabled ? 'Switch this pass off' : 'Switch this pass on'} />
              <Button variant='ghost' size='icon' title='Move up (runs earlier)' disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
              <Button variant='ghost' size='icon' title='Move down (runs later)' disabled={i === chain.length - 1} onClick={() => move(i, 1)}>↓</Button>
              {/* A built-in is switched off, never removed: there would be no row left to switch it back on from. */}
              {materialIndex !== null && (
                <Button variant='remove' size='icon' title='Remove pass' onClick={() => removeMaterial(materialIndex)}>✕</Button>
              )}
            </div>
          );
        })}
        {screenAssets.length > 0 ? (
          <Select value='' onChange={(e) => { if (e.target.value) addMaterial(e.target.value) }}>
            <option value=''>Add screen material…</option>
            {screenAssets.filter((a) => !ids.includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        ) : (
          <Hint>No screen-space materials in the library yet — create a material and set its custom shader Mode to <b>Screen (post-process)</b>.</Hint>
        )}
        {props.node.postChain && (
          <Button variant='ghost' onClick={resetChain} title='Follow the renderer default order again'>
            Reset to default order
          </Button>
        )}
      </div>
    </Collapsable>
  );
}
