import { useEffect, useMemo, useRef, useState } from 'react';
import { type TabKind } from './EngineContext';
import { TAB_ASSET_KIND, type EditorTab } from './engineContextTypes';
import { useDocument } from './DocumentContext';
import { usePlayback } from './PlaybackContext';
import { useAssetLibrary } from './AssetLibraryContext';
import { iconFor } from './assets/assetKinds';
import type { AssetKind } from '../utils/vfs';
import { groupTabStrip, type StripEntry } from '../utils/animationWorkspace';
import { Button } from '../components/ui';

// The asset-type icon shown on a tab. `TAB_ASSET_KIND` names the asset each kind edits; the two that edit
// none fall back to a glyph that describes what is on screen — an animation tab is a skinned mesh, and the
// scene tab is a scene.
function tabAssetKind(kind: TabKind): AssetKind {
  if (kind === 'stateMachine') return 'model';
  return TAB_ASSET_KIND[kind] ?? 'scene';
}

// Browser-style tab strip below the top bar: the scene tab (titled with the open scene asset) plus one tab
// per open asset. Tabs are reorderable by drag (HTML5 DnD) and asset tabs are closable; the scene tab is
// unclosable but movable. Every tab shows a dot when it has unsaved edits.
//
// A skeleton's animation editors (its skeleton, clips, animators and blend spaces) are ONE entry: the
// Character Animation workspace. Clicking it returns to whichever part was used last; the workspace bar
// under the strip switches parts. Closing it closes every part, with one unsaved-changes prompt.
export default function TabBar() {
  const { tabs, activeTabId, dirtyTabs, setActiveTab, closeTab, closeTabs, reorderTabs } = useDocument();
  const { rigs, animations, animationFields } = useAssetLibrary();
  const { isPlayMode } = usePlayback();
  const [dragId, setDragId] = useState<string | null>(null);

  const entries = useMemo(() => groupTabStrip(tabs, { rigs, animations, animationFields }), [tabs, rigs, animations, animationFields]);

  // The part each workspace showed last, so returning to it does not always land on its first part.
  const lastMember = useRef(new Map<string, string>());
  useEffect(() => {
    for (const e of entries) if (e.type === 'workspace' && e.memberIds.includes(activeTabId)) lastMember.current.set(e.rigId, activeTabId);
  }, [entries, activeTabId]);

  const byId = (id: string) => tabs.find(t => t.id === id) as EditorTab;

  const render = (entry: StripEntry) => {
    const isWs = entry.type === 'workspace';
    const key = isWs ? `ws:${entry.rigId}` : entry.tabId;
    const memberIds = isWs ? entry.memberIds : [entry.tabId];
    const lead = byId(memberIds[0]);
    const active = memberIds.includes(activeTabId);
    const dirty = memberIds.some(id => dirtyTabs[id]);
    const title = isWs ? entry.title : lead.title;
    const target = isWs ? (lastMember.current.get(entry.rigId) ?? memberIds[0]) : entry.tabId;
    const tooltip = isWs ? `${entry.title} — Character Animation (${memberIds.length} open part${memberIds.length === 1 ? '' : 's'})` : title;
    return (
      <div
        key={key}
        draggable={!isPlayMode}
        onDragStart={(e) => { setDragId(lead.id); e.dataTransfer.setData('text/cleo-doctab', lead.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDrop={(e) => { e.preventDefault(); const from = e.dataTransfer.getData('text/cleo-doctab') || dragId; if (from) reorderTabs(from, lead.id); setDragId(null); }}
        onDragEnd={() => setDragId(null)}
        onClick={() => setActiveTab(target)}
        title={tooltip}
        className={`group flex items-center gap-1 h-[26px] my-[2px] px-2 rounded-t-[6px] cursor-pointer select-none max-w-[200px] border border-b-0 ${active ? 'bg-selected border-fg text-fg' : 'bg-control border-surface-raised text-muted hover:bg-control-hover'} ${isPlayMode ? 'opacity-60 pointer-events-none' : ''}`}
      >
        <img src={iconFor(isWs ? 'animation' : tabAssetKind(lead.kind))} className='w-3.5 h-3.5 shrink-0' alt='' draggable={false} />
        <span className='truncate text-ui'>{title}{isWs && <span className='text-muted'> · Animation</span>}</span>
        {dirty && <span className='ml-auto text-ui-xs leading-none text-warning' title='Unsaved changes'>●</span>}
        {lead.kind !== 'scene' && (
          <Button variant='remove' size='icon' className='w-[14px] h-[14px] p-0 text-ui-sm leading-none hover:bg-fg/20'
            title={isWs ? 'Close this character\'s animation' : 'Close tab'}
            onClick={(e) => { e.stopPropagation(); if (isWs) void closeTabs(memberIds, title); else closeTab(entry.tabId); }}
          >✕</Button>
        )}
      </div>
    );
  };

  return (
    <div className='shrink-0 h-[30px] w-full flex flex-row items-stretch bg-surface-raised border-b border-control px-1 gap-1 overflow-x-auto'>
      {entries.map(render)}
    </div>
  );
}
