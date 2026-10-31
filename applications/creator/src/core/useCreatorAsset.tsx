// Saved Creator assets: a mode's document with a name, kept in the shared Creator library
// (app-kit creatorLibrary) that the editor mirrors into every project's /Creator folder.
//
// A mode works on "Scratch" (its working document, kept in localStorage as before) until **Save as asset**
// names it. From then on every change re-publishes the asset's files, debounced, and the editor follows
// within a second. Opening an asset loads its document as the working one; choosing Scratch again stops
// publishing and keeps that document to go on from.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  creatorChannel, deleteCreatorAsset, getCreatorAsset, getCreatorFiles, hashChunks, listCreatorAssets, newCreatorAssetId,
  putCreatorAsset, renameCreatorAsset, type CreatorAssetKind, type CreatorAssetMeta, type CreatorFile,
} from '@cleo/app-kit/creatorLibrary';
import { confirmDialog, promptDialog } from '@cleo/app-kit/feedback/dialogStore';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { Button, Select } from '@cleo/app-kit/ui';
import type { ExportFile } from './generator';

const PUBLISH_DEBOUNCE_MS = 800;
const activeKey = (kind: CreatorAssetKind) => `cleo_creator_active_${kind}`;

export interface PublishInput<D> {
  /** The document the files were built from: a build that finishes after the document moved on is dropped. */
  from: D;
  /** Every file the editor imports, sidecar JSON included. */
  files: ExportFile[];
  /** Files only the Creator reads back (a user's texture overrides). */
  privateFiles?: ExportFile[];
}

export interface CreatorAssetState<D> {
  kind: CreatorAssetKind;
  /** This mode's saved assets, by name. */
  assets: CreatorAssetMeta[];
  /** The asset being edited, or null on Scratch. */
  active: CreatorAssetMeta | null;
  /** The last revision written for the active asset (shown as "synced"). */
  syncedRevision: number | null;
  saveAs: () => Promise<void>;
  open: (id: string | null) => Promise<void>;
  rename: () => Promise<void>;
  remove: () => Promise<void>;
  /** Queue the active asset's files; written after a quiet spell. A no-op on Scratch. */
  publish: (input: PublishInput<D>) => void;
}

const toFile = (f: ExportFile): CreatorFile => ({ name: f.name, mime: f.mime, blob: new Blob([f.bytes as BlobPart], { type: f.mime }) });

/** The sidecar among the files (`*.json` with a `generator`), parsed. */
function sidecarOf(files: ExportFile[]): Record<string, unknown> | null {
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(new TextDecoder().decode(f.bytes));
      if (j && typeof j === 'object' && 'generator' in j) return j;
    } catch { /* not the sidecar */ }
  }
  return null;
}

/**
 * The mode's saved assets and the active one. `doc`/`setDoc` are the mode's document; `restore` hands
 * back an opened asset's private files (texture overrides) so the mode can re-apply them.
 */
export function useCreatorAsset<D>(kind: CreatorAssetKind, doc: D, setDoc: (d: D) => void,
                                   restore?: (files: CreatorFile[]) => void): CreatorAssetState<D> {
  const [assets, setAssets] = useState<CreatorAssetMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(activeKey(kind)));
  const [syncedRevision, setSynced] = useState<number | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  const refresh = useCallback(async () => {
    const all = (await listCreatorAssets()).filter(a => a.kind === kind && !a.deleted).sort((a, b) => a.name.localeCompare(b.name));
    setAssets(all);
    return all;
  }, [kind]);

  useEffect(() => {
    refresh().then(all => {
      // The remembered asset is gone (deleted from another window): back to Scratch.
      if (activeId && !all.some(a => a.id === activeId)) choose(null);
    });
    return creatorChannel().subscribe(() => { void refresh(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const choose = (id: string | null) => {
    setActiveId(id);
    setSynced(null);
    if (id) localStorage.setItem(activeKey(kind), id); else localStorage.removeItem(activeKey(kind));
  };
  const active = assets.find(a => a.id === activeId) ?? null;

  // --- publishing, debounced ---
  const pending = useRef<{ input: PublishInput<D>; id: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    timer.current = null;
    const job = pending.current;
    pending.current = null;
    if (!job || job.input.from !== docRef.current) return;
    const meta = await getCreatorAsset(job.id);
    if (!meta || meta.deleted) return;
    const { files, privateFiles = [] } = job.input;
    const docJson = new TextEncoder().encode(JSON.stringify(docRef.current));
    const contentHash = hashChunks([docJson, ...files.map(f => new TextEncoder().encode(f.name)), ...files.map(f => f.bytes),
                                    ...privateFiles.map(f => f.bytes)]);
    try {
      const written = await putCreatorAsset({
        id: meta.id, kind, name: meta.name, doc: docRef.current, sidecar: sidecarOf(files),
        files: files.map(toFile), privateFiles: privateFiles.map(toFile), contentHash,
      });
      setSynced(written?.revision ?? meta.revision);
    } catch (e) {
      toast.error(String((e as Error)?.message ?? e), { title: 'Could not save the asset' });
    }
  }, [kind]);
  const publish = useCallback((input: PublishInput<D>) => {
    if (!activeId || input.from !== docRef.current) return;
    pending.current = { input, id: activeId };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, PUBLISH_DEBOUNCE_MS);
  }, [activeId, flush]);
  // Leaving the mode (or the page) writes what is queued rather than dropping it.
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flush(); } }, [flush]);

  const askName = (title: string, defaultValue: string) => promptDialog({
    title, defaultValue, confirmLabel: 'Save',
    message: 'Saved assets appear in the Cleo Editor under /Creator in every project, and follow every change you make here.',
    validate: v => v.trim() ? null : 'Give the asset a name.',
  });

  const saveAs = async () => {
    const name = await askName('Save as asset', active ? `${active.name} copy` : '');
    if (!name) return;
    const id = newCreatorAssetId(kind);
    // An empty first revision; the mode's next build publishes its files into it.
    await putCreatorAsset({ id, kind, name: name.trim(), doc: docRef.current, sidecar: null, files: [], contentHash: '' });
    await refresh();
    choose(id);
    toast.success(`${name.trim()} is saved and syncs to the editor.`);
  };

  const open = async (id: string | null) => {
    if (timer.current) { clearTimeout(timer.current); await flush(); }
    if (!id) { choose(null); return; }
    const meta = await getCreatorAsset(id);
    if (!meta || meta.deleted) return;
    choose(id);
    if (meta.doc) setDoc(meta.doc as D);
    if (restore && meta.privateFileNames.length) restore(await getCreatorFiles(id, meta.privateFileNames));
  };

  const rename = async () => {
    if (!active) return;
    const name = await askName('Rename asset', active.name);
    if (name && name.trim() !== active.name) { await renameCreatorAsset(active.id, name.trim()); await refresh(); }
  };

  const remove = async () => {
    if (!active) return;
    const ok = await confirmDialog({
      title: `Delete ${active.name}?`, tone: 'danger', confirmLabel: 'Delete',
      message: 'It is removed from the Creator library. Editor projects that use it keep their copy, marked as removed.',
    });
    if (!ok) return;
    await deleteCreatorAsset(active.id);
    choose(null);
    await refresh();
  };

  return { kind, assets, active, syncedRevision, saveAs, open, rename, remove, publish };
}

/** The toolbar's asset controls: Scratch or a saved asset, and Save as / Rename / Delete. */
export function AssetBar<D>({ state }: { state: CreatorAssetState<D> }) {
  const { assets, active, syncedRevision } = state;
  return (
    <div className='flex items-center gap-1'>
      <Select value={active?.id ?? ''} className='w-40'
              title='The asset being edited. Scratch is not shared; a saved asset syncs into the editor as you edit it.'
              onChange={e => void state.open(e.target.value || null)}>
        <option value=''>Scratch</option>
        {assets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
      <Button size='sm' onClick={() => void state.saveAs()} title='Name this as an asset: it appears in the editor under /Creator and follows every change.'>Save as asset…</Button>
      {active && <Button size='sm' variant='ghost' onClick={() => void state.rename()}>Rename</Button>}
      {active && <Button size='sm' variant='ghost' onClick={() => void state.remove()}>Delete</Button>}
      {active && <span className='text-ui-xs text-muted px-1'>{syncedRevision ? `synced · r${syncedRevision}` : 'syncing…'}</span>}
    </div>
  );
}
