// Saved Creator assets: a mode's document with a name, kept in the shared Creator library
// (app-kit creatorLibrary) that the editor mirrors into every project's /Creator folder.
//
// A mode works on "Scratch" (its working document, kept in localStorage as before) until **Save as asset**
// names it. From then on every change re-publishes the asset's files, debounced, and the editor follows
// within a second. Opening an asset (from the Assets explorer: the one place assets are listed, opened,
// renamed, moved and deleted) loads its document as the working one; the toolbar's asset chip shows the
// name, renames it, and goes back to Scratch, which stops publishing and keeps that document to go on from.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  creatorChannel, getCreatorAsset, getCreatorFiles, hashChunks, listCreatorAssets, newCreatorAssetId,
  putCreatorAsset, renameCreatorAsset, type CreatorAssetKind, type CreatorAssetMeta, type CreatorFile,
} from '@cleo/app-kit/creatorLibrary';
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { Button, cn } from '@cleo/app-kit/ui';
import type { ExportFile } from './generator';
import { subscribeOpen, takeOpen } from './creatorOpen';

const PUBLISH_DEBOUNCE_MS = 800;
const activeKey = (kind: CreatorAssetKind) => `cleo_creator_active_${kind}`;
/** What a mode's files are named after while it is on Scratch (Download). */
export const SCRATCH_NAME = 'untitled';

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
  /** Whether `assets` has been read from the library yet. */
  loaded: boolean;
  /** The asset being edited, or null on Scratch. */
  active: CreatorAssetMeta | null;
  /** The name files are written under: the active asset's, or `untitled` on Scratch. */
  name: string;
  /** The last revision written for the active asset (shown as "synced"). */
  syncedRevision: number | null;
  saveAs: () => Promise<void>;
  open: (id: string | null) => Promise<void>;
  rename: () => Promise<void>;
  /** Queue the active asset's files; written after a quiet spell. A no-op on Scratch. */
  publish: (input: PublishInput<D>) => void;
}

export interface CreatorAssetOptions {
  /**
   * The Assets explorer asked to open an asset of this kind. Without it the asset is opened as the working
   * document; with it, the mode decides (the Motion Creator opens a Pose asset in its Pose view).
   */
  onExternalOpen?: (id: string) => void;
  /** An asset of this kind was written (after a publish). */
  onPublished?: (meta: CreatorAssetMeta) => void;
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
 * Write an asset's document and files to the library (a new revision when anything changed): what a
 * publish does, also used to write assets that are not the one being edited (a motion that uses a pose
 * just changed, a migrated pose or variant).
 */
export async function writeCreatorAsset(input: {
  id: string; kind: CreatorAssetKind; name: string; doc: unknown; files: ExportFile[]; privateFiles?: ExportFile[]; thumbnail?: string;
}): Promise<CreatorAssetMeta | null> {
  const { files, privateFiles = [] } = input;
  const enc = new TextEncoder();
  const contentHash = hashChunks([enc.encode(JSON.stringify(input.doc)), ...files.map(f => enc.encode(f.name)), ...files.map(f => f.bytes),
                                  ...privateFiles.map(f => f.bytes)]);
  return putCreatorAsset({
    id: input.id, kind: input.kind, name: input.name, doc: input.doc, sidecar: sidecarOf(files),
    files: files.map(toFile), privateFiles: privateFiles.map(toFile), contentHash, thumbnail: input.thumbnail,
  });
}

/** A new library asset (an id of its kind), written at once. */
export async function createCreatorAsset(kind: CreatorAssetKind, name: string, doc: unknown, files: ExportFile[] = [], thumbnail?: string): Promise<string> {
  const id = newCreatorAssetId(kind);
  await writeCreatorAsset({ id, kind, name, doc, files, thumbnail });
  return id;
}

/**
 * The mode's saved assets and the active one. `doc`/`setDoc` are the mode's document; `restore` hands
 * back an opened asset's private files (texture overrides) so the mode can re-apply them.
 */
export function useCreatorAsset<D>(kind: CreatorAssetKind, doc: D, setDoc: (d: D) => void,
                                   restore?: (files: CreatorFile[]) => void,
                                   /** A small PNG data URL of the stage, for the Assets explorer's card. */
                                   capture?: () => Promise<string>,
                                   options: CreatorAssetOptions = {}): CreatorAssetState<D> {
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [assets, setAssets] = useState<CreatorAssetMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(activeKey(kind)));
  const [syncedRevision, setSynced] = useState<number | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  const refresh = useCallback(async () => {
    const all = (await listCreatorAssets()).filter(a => a.kind === kind && !a.deleted).sort((a, b) => a.name.localeCompare(b.name));
    setAssets(all);
    setLoaded(true);
    return all;
  }, [kind]);

  useEffect(() => {
    refresh().then(all => {
      // The remembered asset is gone (deleted from another window): back to Scratch.
      if (activeId && !all.some(a => a.id === activeId)) choose(null);
    });
    return creatorChannel().subscribe(msg => {
      void refresh().then(all => {
        // The asset being edited was deleted (in the Assets explorer, or another window): back to Scratch.
        if (msg.type === 'delete' && msg.id === activeRef.current && !all.some(a => a.id === msg.id)) choose(null);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const choose = (id: string | null) => {
    setActiveId(id);
    activeRef.current = id;
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
    let thumbnail: string | undefined;
    try { thumbnail = await captureRef.current?.() || undefined; } catch { /* a missing picture is fine */ }
    try {
      // The document the files were built from (the working one when the job was taken; it may have moved
      // on, or gone, while the thumbnail was taken).
      const written = await writeCreatorAsset({
        id: meta.id, kind, name: meta.name, doc: job.input.from, files: job.input.files, privateFiles: job.input.privateFiles, thumbnail,
      });
      setSynced(written?.revision ?? meta.revision);
      if (written) optionsRef.current.onPublished?.(written);
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

  // An asset the Assets explorer asked this tool to open: one waiting from before it mounted, or a later one.
  const openRef = useRef<(id: string | null) => Promise<void>>(async () => {});
  useEffect(() => {
    const take = () => {
      const id = takeOpen(kind);
      if (!id) return;
      if (optionsRef.current.onExternalOpen) optionsRef.current.onExternalOpen(id);
      else void openRef.current(id);
    };
    take();
    return subscribeOpen(take);
  }, [kind]);

  const askName = (title: string, defaultValue: string) => promptDialog({
    title, defaultValue, confirmLabel: 'Save',
    message: 'Saved assets appear in the Cleo Editor under /Creator in every project, and follow every change you make here.',
    validate: v => v.trim() ? null : 'Give the asset a name.',
  });

  const saveAs = async () => {
    const name = await askName('Save as asset', active ? `${active.name} copy` : '');
    if (!name) return;
    // An empty first revision; the mode's next build publishes its files into it.
    const id = await createCreatorAsset(kind, name.trim(), docRef.current);
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

  openRef.current = open;

  const rename = async () => {
    if (!active) return;
    const name = await promptDialog({
      title: 'Rename asset', defaultValue: active.name, confirmLabel: 'Rename',
      message: 'The files it writes, and its copy in the editor, take the new name.',
      validate: v => v.trim() ? null : 'Give the asset a name.',
    });
    if (name && name.trim() !== active.name) { await renameCreatorAsset(active.id, name.trim()); await refresh(); }
  };

  return { kind, assets, loaded, active, name: active?.name ?? SCRATCH_NAME, syncedRevision, saveAs, open, rename, publish };
}

/**
 * The toolbar's asset chip. On Scratch: Save as asset…. On a saved asset: its name (click to rename), a dot
 * that is green once the last change reached the library, and ✕ back to Scratch. Everything else -- open,
 * duplicate, move, delete -- is the Assets explorer's.
 */
export function AssetBar<D>({ state }: { state: CreatorAssetState<D> }) {
  const { active, syncedRevision } = state;
  if (!active) {
    return (
      <div className='flex items-center gap-1'>
        <span className='text-ui-sm text-dim px-1' title='Not shared: this document lives in the browser until it is saved as an asset'>Scratch</span>
        <Button size='sm' onClick={() => void state.saveAs()} title='Name this as an asset: it appears in the editor under /Creator and follows every change.'>Save as asset…</Button>
      </div>
    );
  }
  return (
    <div className='flex items-center gap-0.5'>
      <button type='button' onClick={() => void state.rename()} title={`${active.name} · click to rename · ${syncedRevision ? `synced (revision ${syncedRevision})` : 'saving…'}`}
              className='flex items-center gap-1.5 max-w-[220px] rounded border border-border bg-surface-raised/60 px-2 py-0.5 text-ui-sm text-fg hover:bg-surface-raised'>
        <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', syncedRevision ? 'bg-success' : 'bg-warning')} />
        <span className='truncate'>{active.name}</span>
      </button>
      <Button size='icon' variant='ghost' title='Back to Scratch: stop editing this asset (it stays in the library, in Assets)'
              onClick={() => void state.open(null)}>✕</Button>
    </div>
  );
}
