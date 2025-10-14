import { useEffect, useMemo, useRef, useState } from 'react';
// import Collapsable from '../../components/Collapsable';
import { useCleoEngine } from '../EngineContext';
import { Texture, TextureManager } from 'cleo';

// Simple card for a texture asset. Later we can extend for models, sounds, etc.
function TextureCard({ id }: { id: string }) {
  const { eventEmitter } = useCleoEngine();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const currentImgElRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const attach = () => {
      const tex = TextureManager.Instance.getTexture(id);
      if (!tex) {
        setImg(null);
        setIsLoading(false);
        return;
      }
      const data = tex.data as HTMLImageElement | null;
      if (!data) {
        setImg(null);
        setIsLoading(false);
        return;
      }

      const imgEl = data as HTMLImageElement;
      currentImgElRef.current = imgEl;

      const onLoad = () => {
        setImg(imgEl);
        setIsLoading(false);
      };
      const onError = () => {
        setImg(null);
        setIsLoading(false);
      };

      if (imgEl.complete && imgEl.naturalWidth > 0) {
        setImg(imgEl);
        setIsLoading(false);
      } else {
        setIsLoading(true);
        imgEl.addEventListener('load', onLoad, { once: true });
        imgEl.addEventListener('error', onError, { once: true });
      }

      return () => {
        imgEl.removeEventListener('load', onLoad as any);
        imgEl.removeEventListener('error', onError as any);
      };
    };

    const cleanup = attach();
    const handleChanged = () => attach();
    eventEmitter.on('TEXTURES_CHANGED', handleChanged);

    return () => {
      eventEmitter.off('TEXTURES_CHANGED', handleChanged);
      if (cleanup) cleanup();
    };
  }, [id, eventEmitter]);

  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    // Mark this as a cleo texture asset drag
    const payload = JSON.stringify({ type: 'texture', id });
    e.dataTransfer.setData('text/cleo-asset', payload);
    e.dataTransfer.setData('text/plain', id); // fallback
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div
      className="flex flex-col items-center justify-start w-[120px] m-1 p-2 bg-[#2a2a2a] border border-[#3b3b3b] rounded"
      draggable
      onDragStart={onDragStart}
      title={`Drag to assign: ${id}`}
    >
      <div className="w-[96px] h-[96px] bg-[#1a1a1a] flex items-center justify-center overflow-hidden">
        {img ? (
          <img src={(img as HTMLImageElement).src} alt={id} className="object-contain max-w-[96px] max-h-[96px] pointer-events-none" />
        ) : (
          <div className="text-xs text-gray-400">{isLoading ? 'Loading...' : 'No preview'}</div>
        )}
      </div>
      <div title={id} className="mt-2 w-full text-xs text-ellipsis overflow-hidden whitespace-nowrap text-center">{id}</div>
    </div>
  );
}

export default function AssetExplorer() {
  const { eventEmitter } = useCleoEngine();
  const [textureIds, setTextureIds] = useState<string[]>([]);

  const refreshTextures = () => {
    const textures: Map<string, Texture> = TextureManager.Instance.textures;
    const ids = Array.from(textures.keys()).filter(key => !(key.includes('__editor__') || key.includes('__debug__')));
    setTextureIds(ids);
  };

  useEffect(() => {
    const handleTexturesChanged = () => refreshTextures();
    refreshTextures();
    eventEmitter.on('TEXTURES_CHANGED', handleTexturesChanged);
    return () => {
      eventEmitter.off('TEXTURES_CHANGED', handleTexturesChanged);
    };
  }, [eventEmitter]);

  const handleRefresh = () => {
    // re-emit change in case some publishers didn't fire it
    eventEmitter.emit('TEXTURES_CHANGED');
    // also force local refresh
    refreshTextures();
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const arr = Array.from(files);
    for (const file of arr) {
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
  };

  return (
    <div className="flex flex-col w-full h-full p-2">
      <div className="flex items-center gap-2 mb-2">
        <label htmlFor="asset-upload" className="bg-[#3b3b3b] text-white border border-black px-2 py-1 rounded cursor-pointer">Upload Textures</label>
        <input id="asset-upload" type="file" className="hidden" multiple accept=".png,.jpg,.jpeg,.tga,.bmp" onChange={onUpload} />
        <button onClick={handleRefresh} className="px-2 py-1 rounded bg-[#3b3b3b] hover:bg-[#4b4b4b] text-white border border-black">Refresh</button>
      </div>
      <div className="flex-1 min-h-0 bg-[#202020] border border-[#2c2c2c] rounded p-2 overflow-auto">
        <div className="flex flex-row flex-wrap">
          {textureIds.map(id => (
            <TextureCard key={id} id={id} />
          ))}
        </div>
      </div>
    </div>
  );
}
