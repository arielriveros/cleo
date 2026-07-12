import { useEffect, useState } from 'react';
import { useCleoEngine } from '../EngineContext';
import { Texture, TextureManager } from 'cleo';
import { collectReferencedTextureIds } from '../../utils/references';
import { useMultiSelect, BatchDeleteBar } from '../explorerSelection';
import { UnreferencedBadge } from '../../components/ui';

// A single loaded-texture card. Mirrors the Materials/Meshes explorer cards (96px, 80px thumbnail, name,
// delete). Draggable as a `text/cleo-asset` texture payload to assign onto material slots.
function TextureCard({ id, unreferenced, selected, onToggle }: { id: string; unreferenced: boolean; selected: boolean; onToggle: (id: string) => void }) {
  const { eventEmitter } = useCleoEngine();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const attach = () => {
      const tex = TextureManager.Instance.getTexture(id);
      const data = tex ? (tex.data as HTMLImageElement | null) : null;
      if (!data) { setImg(null); setIsLoading(false); return; }

      if (data.complete && data.naturalWidth > 0) { setImg(data); setIsLoading(false); return; }

      setIsLoading(true);
      const onLoad = () => { setImg(data); setIsLoading(false); };
      const onError = () => { setImg(null); setIsLoading(false); };
      data.addEventListener('load', onLoad, { once: true });
      data.addEventListener('error', onError, { once: true });
      return () => { data.removeEventListener('load', onLoad); data.removeEventListener('error', onError); };
    };

    const cleanup = attach();
    const handleChanged = () => attach();
    eventEmitter.on('TEXTURES_CHANGED', handleChanged);
    return () => { eventEmitter.off('TEXTURES_CHANGED', handleChanged); if (cleanup) cleanup(); };
  }, [id, eventEmitter]);

  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('text/cleo-asset', JSON.stringify({ type: 'texture', id }));
    e.dataTransfer.setData('text/plain', id); // fallback
    e.dataTransfer.effectAllowed = 'copy';
  };

  const onDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete texture "${id}"? Materials using it will show no texture.`)) return;
    TextureManager.Instance.removeTexture(id);
    eventEmitter.emit('TEXTURES_CHANGED');
  };

  return (
    <div
      className={`w-[96px] flex flex-col items-center bg-control border border-border rounded p-1 cursor-grab ${selected ? 'ring-2 ring-selected' : ''}`}
      draggable
      onDragStart={onDragStart}
      onClick={() => onToggle(id)}
      title={`Drag onto a material slot to assign: ${id}`}
    >
      <div className='relative w-[80px] h-[80px] rounded overflow-hidden bg-surface-raised flex items-center justify-center'>
        {unreferenced && <UnreferencedBadge />}
        {img
          ? <img src={img.src} className='w-full h-full object-cover' alt={id} draggable={false} />
          : <span className='text-[10px] text-gray-400'>{isLoading ? 'Loading…' : '🖼️'}</span>}
      </div>
      <span className='truncate w-full text-center text-xs mt-1' title={id}>{id}</span>
      <div className='flex gap-3 mt-1'>
        <button className='text-red-300 text-xs' onClick={onDelete} title='Delete texture'>🗑</button>
      </div>
    </div>
  );
}

// Bottom-bar "Textures" panel: every loaded (non-built-in) texture, with upload + per-texture delete.
// Styled to match the Templates / Materials / Meshes explorers.
export default function AssetExplorer() {
  const { eventEmitter, mainScene, materials, meshes, templates, terrainMaterials } = useCleoEngine();
  const [textureIds, setTextureIds] = useState<string[]>([]);

  const refreshTextures = () => {
    const textures: Map<string, Texture> = TextureManager.Instance.textures;
    const ids = Array.from(textures.keys()).filter(
      key => !(key.includes('__editor__') || key.includes('__debug__') || key === 'Null')
    );
    setTextureIds(ids);
  };

  useEffect(() => {
    const refresh = () => refreshTextures();
    refreshTextures();
    // TEXTURES_CHANGED covers add/remove; SCENE_CHANGED covers (un)assigning a texture to a node's material.
    eventEmitter.on('TEXTURES_CHANGED', refresh);
    eventEmitter.on('SCENE_CHANGED', refresh);
    return () => { eventEmitter.off('TEXTURES_CHANGED', refresh); eventEmitter.off('SCENE_CHANGED', refresh); };
  }, [eventEmitter]);

  // Texture ids used by any material anywhere; the rest get the "not referenced" badge.
  const referenced = collectReferencedTextureIds(mainScene, materials, meshes, templates, terrainMaterials);

  const { selected, toggle, clear, has } = useMultiSelect(textureIds);
  const batchDelete = () => {
    if (!window.confirm(`Delete ${selected.size} selected textures? This can't be undone.`)) return;
    selected.forEach(id => TextureManager.Instance.removeTexture(id));
    eventEmitter.emit('TEXTURES_CHANGED');
    clear();
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const data = ev.target?.result as string | undefined;
        if (data) {
          TextureManager.Instance.addTextureFromBase64(data, { wrapping: 'repeat' }, file.name);
          eventEmitter.emit('TEXTURES_CHANGED');
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  return (
    <div className='w-full h-full p-2 text-white text-sm'>
      <div className='flex items-center gap-2 mb-3'>
        <label htmlFor='asset-upload' className='bg-success hover:bg-success-hover rounded px-2 py-2 text-xs font-semibold cursor-pointer'>
          + Upload Textures
        </label>
        <input id='asset-upload' type='file' className='hidden' multiple accept='.png,.jpg,.jpeg,.tga,.bmp,.webp' onChange={onUpload} />
        <button
          onClick={() => { eventEmitter.emit('TEXTURES_CHANGED'); refreshTextures(); }}
          className='bg-control hover:bg-control-hover border border-border rounded px-2 py-2 text-xs'>
          Refresh
        </button>
        <BatchDeleteBar count={selected.size} noun='textures' onDelete={batchDelete} onClear={clear} />
      </div>

      {textureIds.length === 0 && <p className='text-xs text-gray-500'>No textures loaded.</p>}

      <div className='flex flex-wrap gap-2'>
        {textureIds.map(id => <TextureCard key={id} id={id} unreferenced={!referenced.has(id)} selected={has(id)} onToggle={toggle} />)}
      </div>
    </div>
  );
}
