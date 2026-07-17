import { useState } from 'react';
import { useCleoEngine, type TabKind } from './EngineContext';
import { iconFor } from './assets/assetKinds';
import type { AssetKind } from '../utils/vfs';

// The asset-type icon shown on a tab. Most tab kinds map 1:1 to an AssetKind; an animation tab (a skinned
// mesh) reuses the mesh glyph.
function tabAssetKind(kind: TabKind): AssetKind {
  switch (kind) {
    case 'material': return 'material';
    case 'terrainMaterial': return 'terrainMaterial';
    case 'template': return 'template';
    case 'mesh': return 'mesh';
    case 'script': return 'script';
    case 'animation': return 'mesh';
    default: return 'scene';
  }
}

// Browser-style tab strip below the top bar: the scene tab (titled with the open scene asset) plus one tab
// per open asset. Tabs are reorderable by drag (HTML5 DnD, same idiom as the scene tree) and asset tabs are
// closable; the scene tab is unclosable but movable — closing it would leave nothing to show, since the
// engine always has a scene loaded. Every tab shows a dot when it has unsaved edits.
export default function TabBar() {
  const { tabs, activeTabId, dirtyTabs, setActiveTab, closeTab, reorderTabs, isPlayMode } = useCleoEngine();
  const [dragId, setDragId] = useState<string | null>(null);

  return (
    <div className='shrink-0 h-[30px] w-full flex flex-row items-stretch bg-surface-raised border-b border-control px-1 gap-1 overflow-x-auto'>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const dirty = !!dirtyTabs[tab.id];
        return (
          <div
            key={tab.id}
            draggable={!isPlayMode}
            onDragStart={(e) => { setDragId(tab.id); e.dataTransfer.setData('text/cleo-doctab', tab.id); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => { e.preventDefault(); const from = e.dataTransfer.getData('text/cleo-doctab') || dragId; if (from) reorderTabs(from, tab.id); setDragId(null); }}
            onDragEnd={() => setDragId(null)}
            onClick={() => setActiveTab(tab.id)}
            title={tab.title}
            className={`group flex items-center gap-1 h-[26px] my-[2px] px-2 rounded-t-[6px] cursor-pointer select-none max-w-[180px] border border-b-0 ${active ? 'bg-selected border-white text-white' : 'bg-control border-surface-raised text-muted hover:bg-control-hover'} ${isPlayMode ? 'opacity-60 pointer-events-none' : ''}`}
          >
            <img src={iconFor(tabAssetKind(tab.kind))} className='w-3.5 h-3.5 shrink-0' alt='' draggable={false} />
            <span className='truncate text-xs'>{tab.title}</span>
            {dirty && <span className='ml-auto text-[10px] leading-none text-warning' title='Unsaved changes'>●</span>}
            {tab.kind !== 'scene' && (
              <button
                className='w-[14px] h-[14px] flex items-center justify-center rounded text-[11px] leading-none text-muted hover:bg-white/20 hover:text-white'
                title='Close tab'
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              >✕</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
