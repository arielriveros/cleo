import React, { useEffect, useState, useRef } from 'react'
import { TextureManager, Material } from 'cleo';
import { useCleoEngine } from '../../EngineContext';
import ImportIcon from '../../../icons/import.png';
import NullImage from '../../../images/null.png';

export default function TextureInspector(props: { tex: string, material: Material }) {
  const { eventEmitter: eventEmitter } = useCleoEngine();
  const [texture, setTexture] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [texturesIds, setTexturesIds] = useState<string[]>([]);
  const [textureMissing, setTextureMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const texId = props.material.textures.get(props.tex);
    setTexture(texId ? texId : null);
  }, [props.material, props.tex])

  useEffect(() => {
    const refresh = () => setTexturesIds(
      Array.from(TextureManager.Instance.textures.keys())
        .filter(key => !(key.includes('__editor__') || key.includes('__debug__')))
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
    if (props.tex === 'baseTexture')
      props.material.properties.set('hasBaseTexture', false)
    else
      props.material.properties.set(`has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`, false)

    setTexture(null);
  }

  const onTextureUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.item(0);
    if (file) {
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
          TextureManager.Instance.addTextureFromData(img, { wrapping: 'repeat' }, texName);
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
  }

  const filtered = texturesIds.filter(id => id.toLowerCase().includes(query.toLowerCase()));

  return (
    <div ref={containerRef} className='relative panel flex flex-col items-center gap-1'>
      {/* Preview with hover controls */}
      <div className='relative group h-24 w-24'>
        {img ? (
          <img className='h-full w-full object-cover rounded' src={img.src} />
        ) : (
          <div className='h-full w-full rounded border border-dashed border-[#2d2d77] grid place-items-center text-xs text-slate-400'>
            No texture
          </div>
        )}

        <div className={`absolute inset-0 transition-opacity ${open ? 'opacity-100 visible' : 'opacity-0 invisible group-hover:opacity-100 group-hover:visible'}`}>
          <button
            className='absolute top-1 right-1 h-6 w-6 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center border border-red-700'
            title='Remove texture'
            onClick={deleteTexture}
            disabled={!texture}
          >
            ✕
          </button>
          <div className='absolute left-1 right-1 bottom-1 flex items-center gap-1'>
            <button
              className='flex-1 px-2 py-1 rounded bg-black/60 hover:bg-black/75 text-white text-xs border border-white/20'
              title='Select texture'
              onClick={() => setOpen(v => !v)}
            >
              Select
            </button>
            <button
              className='px-2 py-1 rounded bg-black/60 hover:bg-black/75 text-white text-xs border border-white/20'
              title='Upload texture'
              aria-label='Upload texture'
              onClick={() => fileInputRef.current?.click()}
            >
              <img src={ImportIcon} alt='' className='w-4 h-4 object-contain inline-block align-middle' />
            </button>
          </div>

          {open && (
            <div className='absolute left-0 top-full mt-2 z-[9999] w-64 panel p-2 flex flex-col gap-2'>
              <input
                className='input w-full'
                placeholder='Search textures...'
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              <div className='max-h-56 overflow-auto rounded border border-[#2d2d77] bg-[#2b2b2b]'>
                <button className='w-full text-left px-2 py-1 hover:bg-[#3b3b3b]' onClick={() => onTextureSelect('None')}>None</button>
                {filtered.map((key) => (
                  <button key={key} className='w-full text-left px-2 py-1 hover:bg-[#3b3b3b]' onClick={() => onTextureSelect(key)}>
                    {key}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div className='px-2 py-3 text-sm text-slate-400'>No matches</div>
                )}
              </div>
              <button className='btn w-full' onClick={() => fileInputRef.current?.click()}>Upload...</button>
            </div>
          )}
        </div>
      </div>

      <input ref={fileInputRef} id={`${props.tex}-upload`} className='hidden' type='file' onChange={ e => onTextureUpload(e)} />

      {textureMissing && texture && (
        <div className='absolute -bottom-2 left-2 translate-y-full bg-yellow-500 text-black text-xs px-2 py-1 rounded shadow' title={texture}>
          <span> Missing </span>
          <span> {texture} </span>
        </div>
      )}
    </div>
  )
}