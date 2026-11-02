import React from 'react';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';

// A PBR material's texture slots, and how one is drawn -- shared by the editor's material inspector and
// Cleo Creator's Materials tab, so both list the same slots, in the same order, under the same names,
// in the same tiles. What fills a slot stays each app's own (the editor's texture library, the Creator's
// generated or uploaded images).

export type PbrTextureSlot = 'baseColor' | 'metallic' | 'roughness' | 'normal' | 'occlusion' | 'emissive' | 'height';

/**
 * The slots in inspector order. `key` is the engine Material.PBR texture name. Metallic, Roughness and
 * Occlusion are authored apart and packed into one map before the shader sees them; ONE packed image
 * (a scan's _arm / _orm map) goes in all three.
 */
export const PBR_TEXTURE_SLOTS: { id: PbrTextureSlot; label: string; key: string }[] = [
  { id: 'baseColor', label: 'Base Color', key: 'baseColorTexture' },
  { id: 'metallic', label: 'Metallic', key: 'metallicMap' },
  { id: 'roughness', label: 'Roughness', key: 'roughnessMap' },
  { id: 'normal', label: 'Normal', key: 'normalMap' },
  { id: 'occlusion', label: 'Occlusion', key: 'occlusionMap' },
  { id: 'emissive', label: 'Emissive', key: 'emissiveMap' },
  { id: 'height', label: 'Height', key: 'displacementMap' },
];

export const pbrSlotLabel = (id: PbrTextureSlot) => PBR_TEXTURE_SLOTS.find(s => s.id === id)!.label;

/** The row of slots: tiles that wrap. */
export function TextureSlotGrid({ children }: { children: React.ReactNode }) {
  return <div className='flex flex-wrap gap-3'>{children}</div>;
}

/** One slot: its name over the tile, and an optional caption under it. */
export function TextureSlotFrame({ label, caption, title, children }: {
  label: string; caption?: React.ReactNode; title?: string; children: React.ReactNode;
}) {
  return (
    <div className='flex flex-col items-center gap-1' title={title}>
      <span className='text-ui-xs text-muted'>{label}</span>
      {children}
      {caption !== undefined && <span className='max-w-[96px] truncate text-center text-ui-2xs text-dim'>{caption}</span>}
    </div>
  );
}

export interface TextureTileProps {
  /** The image shown, or none for an empty slot. */
  src?: string;
  /** Replace the slot's image with a file from disk. */
  onUpload?: (file: File) => void;
  /** Clear the slot (✕), when it can be cleared. */
  onClear?: () => void;
  clearTitle?: string;
  accept?: string;
}

/**
 * The 96 px tile the editor's slots use: the image (or a dashed "No texture"), with Upload and ✕ on hover.
 * Files dropped on it upload.
 */
export function TextureTile({ src, onUpload, onClear, clearTitle = 'Remove texture', accept = 'image/*' }: TextureTileProps) {
  const input = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  return (
    <div
      className={cn('relative group h-24 w-24 panel', over && 'ring-2 ring-primary')}
      onDragOver={e => { if (onUpload && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        setOver(false);
        const file = e.dataTransfer.files?.[0];
        if (onUpload && file) { e.preventDefault(); onUpload(file); }
      }}>
      {src
        ? <img className='h-full w-full object-cover rounded pointer-events-none cleo-texture-checker' src={src} />
        : <div className='h-full w-full rounded border border-dashed border-border grid place-items-center text-ui text-muted'>No texture</div>}
      {(onUpload || onClear) && (
        <div className='absolute inset-0 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-opacity'>
          {onClear && (
            <Button variant='remove' size='icon' className='absolute top-1 right-1 h-6 w-6 p-0 rounded-full'
                    title={clearTitle} onClick={onClear}>✕</Button>
          )}
          {onUpload && (
            <div className='absolute left-1 right-1 bottom-1 flex'>
              <Button className='flex-1 px-2 bg-scrim/60 hover:bg-scrim/80 border-fg/20' title='Upload an image'
                      onClick={() => input.current?.click()}>Upload…</Button>
            </div>
          )}
        </div>
      )}
      <input ref={input} className='hidden' type='file' accept={accept}
             onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f && onUpload) onUpload(f); }} />
    </div>
  );
}
