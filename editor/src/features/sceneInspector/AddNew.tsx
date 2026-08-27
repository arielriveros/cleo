import { useEffect, useMemo, useState } from 'react';
import { SegmentedControl } from '../../components/ui';
import { useCleoEngine } from '../EngineContext';
import { isWithinTemplateInstance } from '../../utils/templates';
import { ADD_CATEGORIES, ADD_ITEMS, UI_CATEGORIES, AddCategory, AddContext, AddItem, NEW_NODE_MIME, addItemTo } from './addCatalog';

/** Which half of the catalog a palette shows. Two panels, one component. */
export type AddScope = 'scene' | 'ui';

const categoryKey = (scope: AddScope) => `cleo.addnew.category${scope === 'ui' ? '.ui' : ''}`;

// One grid cell. The grid sizes the cell, so a long label wraps to two lines instead of widening its
// column.
const CELL = 'flex flex-col items-center justify-start gap-1 h-[62px] p-1 rounded border border-control bg-control text-white hover:bg-control-hover cursor-pointer';
const CELL_LABEL = 'text-[10px] leading-tight text-center break-words line-clamp-2 w-full';

function AddCell({ item, locked, onAdd }: { item: AddItem, locked: boolean, onAdd: (item: AddItem) => void }) {
  return (
    <button
      type='button'
      className={CELL}
      title={item.label}
      draggable={!locked}
      onDragStart={(e) => {
        // Not also text/plain: the scene tree's reparent path falls back to it and would try to resolve
        // this item id as a node id.
        e.dataTransfer.setData(NEW_NODE_MIME, item.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onAdd(item)}
    >
      <span className='w-[28px] h-[28px] shrink-0 pointer-events-none flex items-center justify-center'><item.icon /></span>
      <span className={CELL_LABEL}>{item.label}</span>
    </button>
  );
}

export default function AddNew({ scope = 'scene' }: { scope?: AddScope }) {
  const { editorScene, selectedNode, editorMode, eventEmitter, triggers } = useCleoEngine();

  // The palette's OWN scope decides its categories, not the editor mode; the hosting panel picks the half.
  const categories = useMemo(
    () => ADD_CATEGORIES.filter(c => UI_CATEGORIES.includes(c.value) === (scope === 'ui')),
    [scope]);

  // Validated against the VISIBLE list, not the whole catalog: a stored value can be valid for the other
  // palette, or name a since-renamed category, and match nothing here.
  const [category, setCategory] = useState<AddCategory>(() => {
    const stored = localStorage.getItem(categoryKey(scope)) as AddCategory | null;
    return stored && categories.some(c => c.value === stored) ? stored : categories[0].value;
  });

  useEffect(() => {
    if (!categories.some(c => c.value === category)) {
      const stored = localStorage.getItem(categoryKey(scope)) as AddCategory | null;
      setCategory(stored && categories.some(c => c.value === stored) ? stored : categories[0].value);
    }
  }, [categories, category, scope]);

  const selectCategory = (next: AddCategory) => {
    setCategory(next);
    try { localStorage.setItem(categoryKey(scope), next); } catch { /* ignore */ }
  };

  // A placed template instance (and its children) is read-only in Scene mode; adding nodes would parent
  // them into the locked subtree, so the whole group is disabled.
  const selectedNodeObj = editorScene && selectedNode ? editorScene.getNodeById(selectedNode) : null;
  const locked = editorMode === 'scene' && isWithinTemplateInstance(selectedNodeObj);

  const ctx: AddContext = { editorScene, eventEmitter, triggers };

  // Clicking parents onto the selection; with no selection the fallback is the scene root, which is only a
  // routing hop since `addItemTo` retargets a UI element to (or creates) a UI root anyway.
  const onAdd = (item: AddItem) => {
    const parent = selectedNodeObj ?? editorScene?.root;
    if (!parent) return;
    addItemTo(item, parent, ctx).catch(err => console.error(err));
  };

  const items = ADD_ITEMS.filter(item => item.category === category);

  return (
    <>
      {locked && <div className='text-[11px] text-warning bg-warning/15 px-2 py-1'>Template instance — edit the template to add nodes.</div>}
      <fieldset disabled={locked} className={`border-0 m-0 p-0 min-w-0 ${locked ? 'opacity-50' : ''}`}>
        <div className='flex flex-col gap-1.5 p-1.5'>
          {/* Two columns in the scene palette: it has seven categories and two of them are two-word
              labels, which clip at three-up in a narrow panel. The UI palette has three short ones. */}
          <SegmentedControl
            size='sm'
            className={`grid gap-1 w-full ${scope === 'ui' ? 'grid-cols-3' : 'grid-cols-2'}`}
            itemClassName='text-center leading-tight'
            options={categories}
            value={category}
            onChange={selectCategory}
          />
          <div className='grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1'>
            {items.map(item => <AddCell key={item.id} item={item} locked={locked} onAdd={onAdd} />)}
          </div>
        </div>
      </fieldset>
    </>
  );
}
