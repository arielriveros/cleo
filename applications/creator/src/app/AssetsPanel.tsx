import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IApi, IParsedEntity } from '@svar-ui/react-filemanager';
import { AssetExplorer } from '@cleo/app-kit/assets/AssetExplorer';
import { useSyncTreeToStore, type FmEntity } from '@cleo/app-kit/assets/fileManagerSync';
import { ancestorsOf, baseOf, dirOf, isUnder, stemOf } from '@cleo/app-kit/assets/paths';
import {
  CREATOR_KINDS, creatorChannel, deleteCreatorAsset, duplicateCreatorAsset, listCreatorAssets, moveCreatorAsset,
  renameCreatorAsset, type CreatorAssetKind, type CreatorAssetMeta,
} from '@cleo/app-kit/creatorLibrary';
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { requestOpen } from '../core/creatorOpen';
import { useCreatorShell } from './shell';

// The Creator's Assets tab: the editor's asset explorer (app-kit AssetExplorer), browsing the shared
// Creator library -- every saved asset, under a root per tool (/Foliage, /FX, /World) and the folders
// filed in it. Opening an asset switches to its tool and loads it; rename, duplicate, move and delete
// act on the library itself, so the editor's /Creator mirror follows. Kept live from the library's
// channel, so a save in this or another window shows up at once.

const ROOT: Record<CreatorAssetKind, string> = { foliage: '/Foliage', fx: '/FX', world: '/World' };
const EXT: Record<CreatorAssetKind, string> = { foliage: '.foliage', fx: '.fx', world: '.world' };
const FOLDERS_KEY = 'cleo_creator_explorer_folders';
const MODE_KEY = 'cleo_creator_explorer_mode';

/** The root a path is under, and the folder below it ('' at the root itself). */
function placeOf(path: string): { kind: CreatorAssetKind; folder: string } | null {
  for (const kind of CREATOR_KINDS) {
    if (isUnder(path, ROOT[kind])) return { kind, folder: path.slice(ROOT[kind].length).replace(/^\//, '') };
  }
  return null;
}

/** A tool's line glyph, as a data URI (the explorer draws icons as images). */
const glyph = (body: string, color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${color}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`)}`;
const ICONS: Record<CreatorAssetKind | 'folder', string> = {
  foliage: glyph("<path d='M12 21V11'/><path d='M12 11c-4 0-7-3-7-7 4 0 7 3 7 7z'/><path d='M12 14c3 0 6-2 6-6-3 0-6 2-6 6z'/>", '#7fc77a'),
  fx: glyph("<path d='M12 3c1 4 5 6 5 11a5 5 0 0 1-10 0c0-3 2-4 2-7 1 1 2 2 3 4 0-3-1-5 0-8z'/>", '#f0a24a'),
  world: glyph("<path d='M3 19l6-9 4 6 3-4 5 7z'/><circle cx='17' cy='6' r='2'/>", '#79a9e8'),
  folder: glyph("<path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>", '#c9b47a'),
};

export function AssetsPanel() {
  const shell = useCreatorShell();
  const [assets, setAssets] = useState<CreatorAssetMeta[]>([]);
  const [ready, setReady] = useState(false);
  /** Empty folders the user made: the library only knows folders that hold something. */
  const [extraFolders, setExtraFolders] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]'); } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(extraFolders)); } catch { /* quota */ } }, [extraFolders]);

  const refresh = useCallback(async () => {
    setAssets((await listCreatorAssets()).filter(a => !a.deleted));
    setReady(true);
  }, []);
  useEffect(() => {
    void refresh();
    return creatorChannel().subscribe(() => { void refresh(); });
  }, [refresh]);

  // Paths for the library: /<Root>/<folder>/<name>.<kind>, a ' (2)' on a name another asset already has.
  const { data, byPath } = useMemo(() => {
    const byPath = new Map<string, CreatorAssetMeta>();
    const files: FmEntity[] = [];
    for (const a of [...assets].sort((x, y) => x.name.localeCompare(y.name))) {
      const dir = a.folder ? `${ROOT[a.kind]}/${a.folder}` : ROOT[a.kind];
      let path = `${dir}/${a.name}${EXT[a.kind]}`;
      for (let n = 2; byPath.has(path); n++) path = `${dir}/${a.name} (${n})${EXT[a.kind]}`;
      byPath.set(path, a);
      files.push({ id: path, type: 'file', date: new Date(a.updatedAt) });
    }
    const folders = new Set<string>(Object.values(ROOT));
    for (const f of [...files.map(f => f.id), ...extraFolders.map(f => `${f}/x`)]) for (const a of ancestorsOf(f)) folders.add(a);
    const sorted = [...folders].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    return { data: [...sorted.map(id => ({ id, type: 'folder' as const })), ...files], byPath };
  }, [assets, extraFolders]);
  const byPathRef = useRef(byPath);
  byPathRef.current = byPath;

  const apiRef = useRef<IApi | null>(null);
  useSyncTreeToStore(apiRef, data, id => {
    const t = byPathRef.current.get(id)?.thumbnail;
    return t ? `${t.length}:${t.slice(-24)}` : '';
  });

  const open = (path: string) => {
    const a = byPathRef.current.get(path);
    if (!a) return;
    requestOpen(a.kind, a.id);
    if (shell.tool !== a.kind) shell.choose(a.kind);
  };

  const init = useCallback((api: IApi) => {
    // Folders only: an asset is made in its tool (Save as asset).
    api.intercept('create-file', (cfg: any) => {
      if (cfg.skipProvider) return true;
      if (cfg.file?.type !== 'folder' || !placeOf(cfg.parent ?? '/')) {
        toast.info('Make folders inside /Foliage, /FX or /World. Assets are made in their tool, with Save as asset.');
        return false;
      }
      return true;
    });
    api.on('create-file', (cfg: any) => {
      if (cfg.skipProvider || !cfg.newId) return;
      setExtraFolders(f => [...new Set([...f, cfg.newId as string])]);
    });

    api.intercept('rename-file', (cfg: any) => {
      if (cfg.skipProvider) return true;
      const a = byPathRef.current.get(cfg.id);
      const name = String(cfg.name ?? '').trim().replace(/\//g, '-');
      if (!a) { toast.info('Folders are renamed by moving what is in them.'); return false; }
      if (!name) return false;
      void renameCreatorAsset(a.id, name.endsWith(EXT[a.kind]) ? stemOf(name) : name);
      return false;
    });

    api.intercept('delete-files', (cfg: any) => {
      if (cfg.skipProvider) return true;
      const ids: string[] = cfg.ids ?? [];
      if (ids.some(id => Object.values(ROOT).includes(id))) { toast.info('The tool folders cannot be deleted.'); return false; }
      const doomed = [...byPathRef.current].filter(([p]) => ids.some(id => isUnder(p, id))).map(([, a]) => a);
      void (async () => {
        if (doomed.length) {
          const ok = await confirmDialog({
            title: doomed.length === 1 ? `Delete ${doomed[0].name}?` : `Delete ${doomed.length} assets?`, tone: 'danger', confirmLabel: 'Delete',
            message: 'They are removed from the Creator library. Editor projects that use one keep their copy, marked as removed.',
          });
          if (!ok) return;
          for (const a of doomed) await deleteCreatorAsset(a.id);
        }
        setExtraFolders(f => f.filter(x => !ids.some(id => isUnder(x, id))));
      })();
      return false;
    });

    api.intercept('move-files', (cfg: any) => {
      if (cfg.skipProvider) return true;
      const target = placeOf(cfg.target ?? '');
      if (!target) return false;
      void (async () => {
        for (const id of cfg.ids ?? []) {
          const from = placeOf(id);
          if (!from || from.kind !== target.kind) { toast.info('An asset stays under its own tool’s folder.'); continue; }
          const moved = [...byPathRef.current].filter(([p]) => isUnder(p, id));
          for (const [p, a] of moved) {
            // A file lands in the target; a folder carries its sub-path along.
            const rel = p === id ? '' : dirOf(p).slice(dirOf(id).length).replace(/^\//, '');
            await moveCreatorAsset(a.id, [target.folder, rel].filter(Boolean).join('/'));
          }
          if (!byPathRef.current.has(id)) setExtraFolders(f => f.map(x => isUnder(x, id) ? `${cfg.target}/${baseOf(id)}${x.slice(id.length)}` : x));
        }
      })();
      return false;
    });

    api.intercept('copy-files', (cfg: any) => {
      if (cfg.skipProvider) return true;
      void (async () => {
        for (const id of cfg.ids ?? []) {
          const a = byPathRef.current.get(id);
          if (a) await duplicateCreatorAsset(a.id, `${a.name} copy`);
        }
      })();
      return false;
    });

    api.on('open-file', (cfg: any) => open(cfg.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previews = useCallback((file: Partial<IParsedEntity>) =>
    file?.id && file.type !== 'folder' ? byPathRef.current.get(file.id)?.thumbnail ?? null : null, []);
  const icons = useCallback((file: Partial<IParsedEntity>) => {
    if (!file?.id || file.type === 'folder') return ICONS.folder;
    const a = byPathRef.current.get(file.id);
    return a ? ICONS[a.kind] : ICONS.folder;
  }, []);

  if (!ready) return <div className='w-full h-full flex items-center justify-center text-ui text-muted'>Loading the library…</div>;
  return (
    <AssetExplorer
      data={data} apiRef={apiRef} init={init} modeKey={MODE_KEY} idPrefix='creator-asset'
      previews={previews} icons={icons}
      toolbarEnd={<span className='ml-auto min-w-0 truncate text-ui-sm text-dim hidden lg:inline'>
        Saved assets of every tool · double-click to open · they appear in the editor under /Creator
      </span>}
    />
  );
}
