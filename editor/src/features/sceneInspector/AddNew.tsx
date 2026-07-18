import { useState } from 'react';
import Collapsable from '../../components/Collapsable';
import { SegmentedControl } from '../../components/ui';
import { useCleoEngine } from '../EngineContext';
import { isWithinTemplateInstance } from '../../utils/templates';
import { ADD_CATEGORIES, ADD_ITEMS, AddCategory, AddContext, AddItem, NEW_NODE_MIME, addItemTo } from './addCatalog';
import ImportIcon from '../../icons/import.png';

const CATEGORY_KEY = 'cleo.addnew.category';

// One grid cell. The grid sizes the cell, so a long label wraps to two lines instead of widening its
// column — which is what used to shove the whole section around in a narrow panel.
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
        // Deliberately not also text/plain: the scene tree's reparent path falls back to it and would
        // try to resolve this item id as a node id.
        e.dataTransfer.setData(NEW_NODE_MIME, item.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onAdd(item)}
    >
      <img className='w-[28px] h-[28px] shrink-0 pointer-events-none' src={item.icon} alt='' />
      <span className={CELL_LABEL}>{item.label}</span>
    </button>
  );
}

// Import / Folder are file pickers, not node factories: they import into the Models library rather than
// the scene, so they stay out of the catalog and aren't draggable.
function ImportCell({ id, label, folder, onFiles }: { id: string, label: string, folder?: boolean, onFiles: (files: FileList | null) => void }) {
  return (
    <>
      <label className={CELL} htmlFor={id} title={label}>
        <img className='w-[28px] h-[28px] shrink-0 pointer-events-none' src={ImportIcon} alt='' />
        <span className={CELL_LABEL}>{label}</span>
      </label>
      <input
        className='hidden' type='file' id={id} name={id}
        {...(folder
          ? ({ webkitdirectory: '', directory: '' } as any)
          : { multiple: true, accept: '.obj, .mtl, .gltf, .glb, .png, .jpg, .jpeg, .bmp, .tga, .tiff' })}
        onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
    </>
  );
}

export default function AddNew() {
  const { editorScene, selectedNode, editorMode, eventEmitter, triggers, importModelFiles } = useCleoEngine();
  // Validated against the current catalog, not trusted verbatim: a category renamed since the value was
  // stored ('meshes' -> 'primitives') would otherwise restore a tab that matches no items and looks empty.
  const [category, setCategory] = useState<AddCategory>(() => {
    const stored = localStorage.getItem(CATEGORY_KEY) as AddCategory | null;
    return stored && ADD_CATEGORIES.some(c => c.value === stored) ? stored : 'common';
  });

  const selectCategory = (next: AddCategory) => {
    setCategory(next);
    try { localStorage.setItem(CATEGORY_KEY, next); } catch { /* ignore */ }
  };

  // A placed template instance (and its children) is read-only in Scene mode; adding nodes would parent
  // them into the locked subtree, so disable the whole group. Computed fresh from the current selection.
  const selectedNodeObj = editorScene && selectedNode ? editorScene.getNodeById(selectedNode) : null;
  const locked = editorMode === 'scene' && isWithinTemplateInstance(selectedNodeObj);

  const ctx: AddContext = { editorScene, eventEmitter, triggers };

  // Clicking still parents onto the selection (drag onto the tree or the viewport to choose a parent).
  const onAdd = (item: AddItem) => {
    if (!selectedNodeObj) return;
    addItemTo(item, selectedNodeObj, ctx).catch(err => console.error(err));
  };

  // Imports land in the Models library (each file becomes a reusable model asset with a thumbnail);
  // drag a card from the Assets panel into the viewport to place it. A folder pick (webkitdirectory) lets
  // a .gltf with an external textures/ folder resolve (the browser hands us every file with its
  // webkitRelativePath).
  const onPickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    eventEmitter.emit('FOCUS_BOTTOM_TAB', 'Assets'); // surface the library so the new cards are visible
    importModelFiles(Array.from(files)).catch((err: unknown) => console.error(err));
  };

  const items = ADD_ITEMS.filter(item => item.category === category);

  return (
    <Collapsable title='Add' persistKey='add'>
      {locked && <div className='text-[11px] text-warning bg-warning/15 px-2 py-1'>Template instance — edit the template to add nodes.</div>}
      <fieldset disabled={locked} className={`border-0 m-0 p-0 min-w-0 ${locked ? 'opacity-50' : ''}`}>
        <div className='flex flex-col gap-1.5 p-1.5'>
          <SegmentedControl
            size='sm'
            className='grid grid-cols-3 gap-1 w-full'
            options={ADD_CATEGORIES}
            value={category}
            onChange={selectCategory}
          />
          <div className='grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1'>
            {items.map(item => <AddCell key={item.id} item={item} locked={locked} onAdd={onAdd} />)}
            {category === 'primitives' && <>
              <ImportCell id='file' label='Import' onFiles={onPickFiles} />
              <ImportCell id='folder' label='Folder' folder onFiles={onPickFiles} />
            </>}
          </div>
        </div>
      </fieldset>
    </Collapsable>
  );
}
