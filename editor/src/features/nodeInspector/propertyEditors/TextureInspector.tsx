import React, { useEffect, useState, useRef } from 'react'
import { TextureManager, Material, isDerivedTextureId } from 'cleo';
import { useEventBus } from '../../EventBusContext';
import { cn, TextInput, Button } from '../../../components/ui';
import ImportIcon from '../../../icons/import.png';
import NullImage from '../../../images/null.png';

const thumbSrc = (id: string): string | undefined => {
  const t = TextureManager.Instance.getTexture(id);
  const data = t ? (t.data as HTMLImageElement | null) : null;
  return data && data.complete ? data.src : undefined;
};

export default function TextureInspector(props: { tex: string, material: Material }) {
  const eventEmitter = useEventBus();
  const [texture, setTexture] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [texturesIds, setTexturesIds] = useState<string[]>([]);
  const [textureMissing, setTextureMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const texId = props.material.textures.get(props.tex);
    setTexture(texId ? texId : null);
  }, [props.material, props.tex])

  useEffect(() => {
    const refresh = () => setTexturesIds(
      // '__packed__' ids are engine-derived channel packs (metallic+roughness+occlusion combined into
      // one texture); they are not assignable — the source maps in the slots above them are.
      Array.from(TextureManager.Instance.textures.keys())
        .filter(key => !(key.includes('__editor__') || key.includes('__debug__') || isDerivedTextureId(key)))
    );
    refresh();
    const handleTexturesChanged = () => {
      refresh();
      if (textureMissing && texture && TextureManager.Instance.getTexture(texture)) {
        setTextureMissing(false);
        setTimeout(() => setImg(TextureManager.Instance.getTexture(texture)!.data as HTMLImageElement), 300);
      }
    }
    eventEmitter.on("TEXTURES_CHANGED", handleTexturesChanged);
    return () => {
      eventEmitter.off("TEXTURES_CHANGED", handleTexturesChanged);
    }
  }, [eventEmitter, textureMissing, texture]);

  useEffect(() => {
    if (texture) {
      const tex = TextureManager.Instance.getTexture(texture);
      if (tex) {
        setImg(tex.data as HTMLImageElement);
        setTextureMissing(false);
      } else {
        const img = new Image();
        img.src = NullImage;
        setImg(img);
        setTextureMissing(true);
      }
    } else {
      setImg(null);
      setTextureMissing(false);
    }
  }, [texture])

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const deleteTexture = () => {
    props.material.textures.delete(props.tex);
    props.material.properties.set(`has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`, false)

    setTexture(null);
    eventEmitter.emit('TEXTURES_CHANGED');
    eventEmitter.emit('SCENE_CHANGED', { kind: 'texture' });
  }

  const onTextureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.item(0);
    if (file) {
      // The compressed bytes, kept so the texture survives a reload: addTextureFromData retains no
      // source, and the texture store persists only textures that have one.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = file.type || 'image/png';
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result;
        const img = new Image();
        img.src = data as string;
        img.onload = () => {
          let texName = file.name;
          // if texture exists, change the name
          let i = 1;
          while (TextureManager.Instance.getTexture(texName)) {
            texName = `${file.name.split('.')[0]}_${i}.${file.name.split('.')[1]}`;
            i++;
          }
          TextureManager.Instance.addTextureFromData(img, { wrapping: 'repeat' }, texName, { bytes, mime });
          onTextureSelect(texName);
          eventEmitter.emit("TEXTURES_CHANGED");
        }
      }
      reader.readAsDataURL(file);
    }
  }

  const onTextureSelect = (textureId: string) => {
    if (textureId === 'None') {
      deleteTexture();
      return;
    }
    props.material.textures.set(props.tex, textureId);
    props.material.properties.set(`has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`, true)
    setTexture(textureId);
    setOpen(false);
    // notify others
    eventEmitter.emit("TEXTURES_CHANGED");
    eventEmitter.emit('SCENE_CHANGED', { kind: 'texture' });
  }

  const allowDrop = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types || []);
    if (types.includes('text/cleo-asset') || types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      return true;
    }
    return false;
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (allowDrop(e)) setIsDragOver(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    setIsDragOver(false);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const custom = e.dataTransfer.getData('text/cleo-asset');
    const plain = e.dataTransfer.getData('text/plain');
    let data: any = null;
    if (custom) {
      try { data = JSON.parse(custom); } catch { data = null; }
    }
    if (!data && plain) {
      data = { type: 'texture', id: plain };
    }
    if (data?.type === 'texture' && typeof data.id === 'string' && data.id.length > 0) {
      if (TextureManager.Instance.getTexture(data.id)) {
        onTextureSelect(data.id);
      }
    }
  };

  const filtered = texturesIds.filter(id => id.toLowerCase().includes(query.toLowerCase()));

  return (
    <div
      ref={containerRef}
      className='relative panel flex flex-col items-center gap-1'
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Preview with hover controls */}
      <div
        className={`relative group h-24 w-24 ${isDragOver ? 'ring-2 ring-primary' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        title='Drop a texture from Assets here'
      >
        {img ? (
          <img className='h-full w-full object-cover rounded pointer-events-none' src={img.src} />
        ) : (
          <div className={`h-full w-full rounded border border-dashed ${isDragOver ? 'border-primary' : 'border-border'} grid place-items-center text-xs text-muted`}>
            {isDragOver ? 'Release to assign' : 'No texture'}
          </div>
        )}

        <div className={`absolute inset-0 transition-opacity ${open ? 'opacity-100 visible' : 'opacity-0 invisible group-hover:opacity-100 group-hover:visible'}`}>
          <button
            className='absolute top-1 right-1 h-6 w-6 rounded-full bg-danger hover:bg-danger-hover text-white flex items-center justify-center border border-danger disabled:opacity-50'
            title='Remove texture'
            onClick={deleteTexture}
            disabled={!texture}
          >
            ✕
          </button>
          <div className='absolute left-1 right-1 bottom-1 flex items-center gap-1'>
            <button
              className='flex-1 px-2 py-1 rounded bg-black/60 hover:bg-black/80 text-white text-xs border border-white/20'
              title='Select texture'
              onClick={() => setOpen(v => !v)}
            >
              Select
            </button>
            <button
              className='px-2 py-1 rounded bg-black/60 hover:bg-black/80 text-white text-xs border border-white/20'
              title='Upload texture'
              aria-label='Upload texture'
              onClick={() => fileInputRef.current?.click()}
            >
              <img src={ImportIcon} alt='' className='w-4 h-4 object-contain inline-block align-middle' />
            </button>
          </div>

          {open && (
            <div className='absolute left-0 top-full mt-2 z-[9999] w-64 rounded-md border border-border bg-surface-raised shadow-lg p-2 flex flex-col gap-2'>
              <TextInput placeholder='Search textures...' value={query} onChange={setQuery} autoFocus />
              <div className='max-h-56 overflow-auto rounded border border-border bg-surface'>
                <button className={cn('w-full flex items-center gap-2 px-2 py-1 hover:bg-control text-left text-xs', !texture && 'bg-control')} onClick={() => onTextureSelect('None')}>
                  <span className='w-7 h-7 rounded bg-surface-raised grid place-items-center shrink-0 text-muted'>∅</span>
                  <span className='truncate'>None</span>
                </button>
                {filtered.map((key) => {
                  const src = thumbSrc(key);
                  return (
                    <button key={key} className={cn('w-full flex items-center gap-2 px-2 py-1 hover:bg-control text-left text-xs', key === texture && 'bg-control')} onClick={() => onTextureSelect(key)}>
                      <span className='w-7 h-7 rounded bg-surface-raised overflow-hidden grid place-items-center shrink-0'>
                        {src ? <img src={src} className='w-full h-full object-cover' /> : <span className='text-[10px]'>🖼️</span>}
                      </span>
                      <span className='truncate flex-1'>{key}</span>
                      {key === texture && <span className='text-primary'>✓</span>}
                    </button>
                  );
                })}
                {filtered.length === 0 && (
                  <div className='px-2 py-3 text-xs text-muted'>No matches</div>
                )}
              </div>
              <Button className='w-full' onClick={() => fileInputRef.current?.click()}>Upload…</Button>
            </div>
          )}
        </div>
      </div>

      <input ref={fileInputRef} id={`${props.tex}-upload`} className='hidden' type='file' onChange={ e => onTextureUpload(e)} />

      {textureMissing && texture && (
        <div className='absolute -bottom-2 left-2 translate-y-full bg-warning text-black text-xs px-2 py-1 rounded shadow' title={texture}>
          <span> Missing </span>
          <span> {texture} </span>
        </div>
      )}
    </div>
  )
}