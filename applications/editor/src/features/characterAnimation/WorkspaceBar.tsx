import { useMemo } from 'react';
import { useDocument } from '../DocumentContext';
import { useAssetLibrary } from '../AssetLibraryContext';
import { useEditorSessions } from '../EditorSessionsContext';
import { usePlayback } from '../PlaybackContext';
import { Button, DocHover, MenuItem, Popover, cn, useDocEntry } from '@cleo/app-kit/ui';
import {
  PART_LABEL, PART_OF_KIND, groupTabStrip, isWorkspaceKind, type WorkspacePart,
} from '../../utils/animationWorkspace';

// The Character Animation workspace's own header: one row under the tab strip, shown while any part of a
// skeleton's animation is open. It is what makes the separate editors read as ONE document — a fixed set
// of parts (Skeleton · Clips · Animator · Blend Spaces), each opening on the item picked from its menu,
// and one Save for everything unsaved in the workspace.

const PARTS: WorkspacePart[] = ['skeleton', 'clips', 'animator', 'blendSpace'];

/**
 * Each part's hover card, from docs/editor/animation.md: the table of parts at the top of that page (Blend
 * Spaces finds its own section there instead, which says the same and how to make one). Written as `doc:`
 * keys so the docs coverage test checks every one of them.
 */
const PART_DOC: Record<WorkspacePart, { doc: string }> = {
  skeleton: { doc: 'editor/animation::Skeleton' },
  clips: { doc: 'editor/animation::Clips' },
  animator: { doc: 'editor/animation::Animator' },
  blendSpace: { doc: 'editor/animation::Blend Spaces' },
};

/** A part's name with its docs card. A component, so each part's lookup is its own hook. */
function PartLabel({ part }: { part: WorkspacePart }) {
  const entry = useDocEntry(PART_LABEL[part], PART_DOC[part].doc);
  return <DocHover entry={entry}>{PART_LABEL[part]}</DocHover>;
}

export default function WorkspaceBar() {
  const { tabs, activeTabId, setActiveTab, dirtyTabs, saveTabs, closeTabs } = useDocument();
  const { rigs, animations, animationFields, animControllers } = useAssetLibrary();
  const {
    enterRigEditor, enterClipEditor, openAnimController, createAnimatorForRig,
    enterAnimationFieldEditor, createAnimationFieldForModel, modelsOnRig,
  } = useEditorSessions();
  const { isPlayMode } = usePlayback();

  const workspace = useMemo(() => {
    const entry = groupTabStrip(tabs, { rigs, animations, animationFields })
      .find(e => e.type === 'workspace' && e.memberIds.includes(activeTabId));
    return entry?.type === 'workspace' ? entry : null;
  }, [tabs, rigs, animations, animationFields, activeTabId]);

  if (!workspace) return null;
  const rig = rigs.find(r => r.id === workspace.rigId);
  if (!rig) return null;

  const members = workspace.memberIds.map(id => tabs.find(t => t.id === id)!).filter(Boolean);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activePart = activeTab && isWorkspaceKind(activeTab.kind) ? PART_OF_KIND[activeTab.kind] : null;
  const dirty = workspace.memberIds.filter(id => dirtyTabs[id]);

  const clips = (rig.animationIds ?? []).map(id => animations.find(a => a.id === id)).filter(Boolean) as typeof animations;
  const animators = animControllers.filter(c => c.rigId === rig.id);
  const characterAnimators = members.filter(t => t.kind === 'stateMachine' && !t.controllerId);
  const fields = animationFields.filter(f => f.rigId === rig.id);
  const previewModel = modelsOnRig(rig.id)[0];

  /** The open member for an item, if any — focusing it keeps its unsaved work instead of reopening. */
  const openMember = (pred: (t: (typeof members)[number]) => boolean) => members.find(pred);
  const focusOr = (pred: (t: (typeof members)[number]) => boolean, open: () => void) => {
    const m = openMember(pred);
    if (m) setActiveTab(m.id); else open();
  };

  const partButton = (part: WorkspacePart, menu?: (close: () => void) => React.ReactNode) => {
    const isActive = activePart === part;
    const partDirty = members.some(t => isWorkspaceKind(t.kind) && PART_OF_KIND[t.kind] === part && dirtyTabs[t.id]);
    const label = (
      <span className='flex items-center gap-1'>
        <PartLabel part={part} />
        {partDirty && <span className='text-warning text-ui-xs leading-none'>●</span>}
        {menu && <span className='text-dim text-ui-xs'>▾</span>}
      </span>
    );
    const cls = cn(
      'h-[24px] px-3 rounded text-ui border',
      isActive ? 'bg-selected border-fg text-fg' : 'bg-transparent border-transparent text-muted hover:text-fg hover:bg-control',
    );
    if (!menu) {
      return (
        <button key={part} type='button' className={cls}
          onClick={() => focusOr(t => t.kind === 'rig' && t.rigId === rig.id, () => enterRigEditor(rig.id))}>
          {label}
        </button>
      );
    }
    return (
      <Popover key={part} trigger={label} triggerClassName={cls} className='min-w-[240px] max-h-[60vh] overflow-y-auto p-1'>
        {close => menu(close)}
      </Popover>
    );
  };

  const empty = (text: string) => <div className='px-2 py-1 text-ui-xs text-dim'>{text}</div>;

  return (
    <div className={cn('shrink-0 h-[32px] w-full flex items-center gap-1 px-2 bg-surface border-b border-control', isPlayMode && 'opacity-60 pointer-events-none')}>
      <span className='text-ui font-medium text-fg mr-2 truncate max-w-[200px]' title={`${rig.name} — Character Animation`}>{rig.name}</span>

      {partButton('skeleton')}

      {partButton('clips', close => (
        <>
          {clips.length === 0 && empty('No clips yet — import them from the Animator, or link one on the Skeleton.')}
          {clips.map(a => (
            <MenuItem key={a.id} active={!!openMember(t => t.kind === 'animation' && t.animationId === a.id)}
              hint={`${a.clips.length} clip${a.clips.length === 1 ? '' : 's'}`}
              onClick={() => { close(); focusOr(t => t.kind === 'animation' && t.animationId === a.id, () => enterClipEditor(a.id)); }}>
              {a.name}
            </MenuItem>
          ))}
        </>
      ))}

      {partButton('animator', close => (
        <>
          {characterAnimators.map(t => (
            <MenuItem key={t.id} active={t.id === activeTabId} hint='This character’s own animator'
              onClick={() => { close(); setActiveTab(t.id); }}>
              {t.title}
            </MenuItem>
          ))}
          {animators.map(c => (
            <MenuItem key={c.id} active={!!openMember(t => t.kind === 'stateMachine' && t.controllerId === c.id)}
              hint='Shared by every character that uses it'
              onClick={() => { close(); focusOr(t => t.kind === 'stateMachine' && t.controllerId === c.id, () => openAnimController(c.id)); }}>
              {c.name}
            </MenuItem>
          ))}
          {!animators.length && !characterAnimators.length && empty('No animator yet.')}
          <div className='border-t border-control my-1' />
          <MenuItem onClick={() => { close(); createAnimatorForRig(rig.id); }} hint='An empty graph for this skeleton'>
            + New Animator
          </MenuItem>
        </>
      ))}

      {partButton('blendSpace', close => (
        <>
          {fields.map(f => (
            <MenuItem key={f.id} active={!!openMember(t => t.kind === 'animationField' && t.animationFieldId === f.id)}
              onClick={() => { close(); focusOr(t => t.kind === 'animationField' && t.animationFieldId === f.id, () => enterAnimationFieldEditor(f.id)); }}>
              {f.name}
            </MenuItem>
          ))}
          {!fields.length && empty('No blend spaces yet.')}
          <div className='border-t border-control my-1' />
          <MenuItem disabled={!previewModel}
            hint={previewModel ? 'Mix this skeleton’s clips on a 1D or 2D plot' : 'Needs a character on this skeleton to preview on'}
            onClick={() => { close(); if (previewModel) createAnimationFieldForModel(previewModel.id); }}>
            + New Blend Space
          </MenuItem>
        </>
      ))}

      <div className='ml-auto flex items-center gap-1'>
        <Button size='sm' variant={dirty.length ? 'primary' : 'subtle'} disabled={!dirty.length}
          title={dirty.length ? `Save everything unsaved in ${rig.name}’s animation (Ctrl+S)` : 'Nothing to save'}
          onClick={() => void saveTabs(dirty, `Saving ${rig.name}`)}>
          Save{dirty.length > 1 ? ` (${dirty.length})` : ''}
        </Button>
        <Button size='sm' variant='ghost' title='Close this character’s animation'
          onClick={() => void closeTabs(workspace.memberIds, rig.name)}>Close</Button>
      </div>
    </div>
  );
}
