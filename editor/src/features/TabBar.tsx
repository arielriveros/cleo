import { useState } from 'react';
import { useCleoEngine } from './EngineContext';

// Browser-style tab strip below the top bar: the Main tab (real scene) plus open template tabs.
// Tabs are reorderable by drag (HTML5 DnD, same idiom as the scene tree) and template tabs are
// closable; the Main tab is unclosable but movable. Template tabs show a dot when they have
// unsaved edits.
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
            {dirty && <span className='text-[10px] leading-none text-warning' title='Unsaved changes'>●</span>}
            <span className='truncate text-xs'>{tab.title}</span>
            {tab.kind !== 'main' && (
              <button
                className='ml-1 w-[14px] h-[14px] flex items-center justify-center rounded text-[11px] leading-none text-muted hover:bg-white/20 hover:text-white'
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
