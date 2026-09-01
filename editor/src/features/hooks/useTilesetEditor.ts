import EventEmitter from '../../utils/eventEmitter';
import { Logger } from 'cleo';
import { TilesetAsset, buildTilesetAsset, guessTileSize } from '../../utils/tilesets';
import { cryptoRandomId } from '../../utils/ids';
import { importAtlasImage } from '../tileset/importAtlas';
import { renderTilesetThumbnail } from '../tileset/tilesetThumbnail';
import type { EditorTab } from '../engineContextTypes';

/**
 * The tileset-tab slice, lifted out of EngineProvider verbatim.
 *
 * It owns no state of its own — a tileset tab's working copy lives in TilesetProvider — so everything it
 * touches (the library, the tab machinery) is handed in. What it does own is the three-way relationship
 * between "open a tileset", "make one out of an image" and "save one", which is why they travel together.
 */
export function useTilesetEditor(deps: {
  tilesetsRef: React.MutableRefObject<TilesetAsset[]>;
  tabsRef: React.MutableRefObject<EditorTab[]>;
  setTabs: React.Dispatch<React.SetStateAction<EditorTab[]>>;
  eventEmitter: React.MutableRefObject<EventEmitter>;
  addTileset: (t: TilesetAsset) => void;
  updateTileset: (id: string, t: TilesetAsset) => void;
  setActiveTab: (id: string) => void;
  commitTab: (tab: EditorTab, adoptTabId?: string) => void;
  clearTabDirty: (id: string) => void;
}) {
  const {
    tilesetsRef, tabsRef, setTabs, eventEmitter,
    addTileset, updateTileset, setActiveTab, commitTab, clearTabDirty,
  } = deps;

  // ---- Tileset editor --------------------------------------------------------------------------------

  // Unlike every other asset tab this one owns NO scene: a tileset is an image with a grid drawn over it,
  // so the tab needs no tabRuntimeRef entry, no throwaway Scene and no renderer involvement.
  const enterTilesetEditor = (tilesetId?: string, adoptTabId?: string) => {
    let asset = tilesetId ? tilesetsRef.current.find(t => t.id === tilesetId) : undefined;

    if (!tilesetId) {
      // A brand-new tileset starts with no atlas: the image is assigned from the editor's own slot, which
      // is where its pixel dimensions come from.
      asset = buildTilesetAsset('Tileset', '', 0, 0);
      addTileset(asset);
      // The library update lands in the next commit, so seed the ref directly — otherwise the tab opens
      // against state that does not yet contain the asset it was just given.
      tilesetsRef.current = [...tilesetsRef.current, asset];
    }
    if (!asset) { Logger.error('Tileset not found', 'Editor'); return; }

    if (!adoptTabId && tilesetId) {
      const existing = tabsRef.current.find(t => t.kind === 'tileset' && t.tilesetId === tilesetId);
      if (existing) { setActiveTab(existing.id); return; }
    }
    const tabId = adoptTabId ?? cryptoRandomId();
    commitTab({ id: tabId, kind: 'tileset', title: asset.name, tilesetId: asset.id }, adoptTabId);
  };

  /**
   * Import an image and build a tileset around it in one step — the "+ Add > Tileset" path. The tile size
   * is guessed from the image. Returns null when the file could not be decoded (importAtlasImage logs why).
   */
  const createTilesetFromImage = async (file: File): Promise<TilesetAsset | null> => {
    const imported = await importAtlasImage(file, (event) => eventEmitter.current.emit(event as any));
    if (!imported) return null;
    const tile = guessTileSize(imported.width, imported.height);
    // A texture's id is its filename; trim the extension for a readable asset name.
    const name = imported.textureId.replace(/\.[^./\\]+$/, '') || imported.textureId;
    const asset = buildTilesetAsset(name, imported.textureId, imported.width, imported.height, {
      tileWidth: tile, tileHeight: tile,
    });
    // The image is already decoded on this path (importAtlasImage registers it through addTextureFromData),
    // so the card preview can be rendered now rather than waiting for the first save.
    asset.thumbnail = renderTilesetThumbnail(asset) ?? undefined;
    addTileset(asset);
    // The library update lands in the next commit, so seed the ref directly — enterTilesetEditor reads it.
    tilesetsRef.current = [...tilesetsRef.current, asset];
    enterTilesetEditor(asset.id);
    // The asset itself, not just its id: a caller that wants to reference it immediately (a sprite's
    // tileset slot) cannot find it in `tilesets` yet — that state update lands a commit later.
    return asset;
  };

  /** Persist an edited tileset and push it into every tilemap already drawing from a copy of it. */
  const saveTileset = (input: TilesetAsset) => {
    // The card preview is a plain canvas downscale of the atlas, cheap enough to refresh on every save.
    const asset = { ...input, thumbnail: renderTilesetThumbnail(input) ?? input.thumbnail };
    updateTileset(asset.id, asset);
    tilesetsRef.current = tilesetsRef.current.map(t => t.id === asset.id ? asset : t);
    const open = tabsRef.current.find(t => t.kind === 'tileset' && t.tilesetId === asset.id);
    if (open) {
      clearTabDirty(open.id);
      if (open.title !== asset.name) setTabs(prev => prev.map(t => t.id === open.id ? { ...t, title: asset.name } : t));
    }
    Logger.info(`Tileset "${asset.name}" saved`, 'Editor');
  };

  return { enterTilesetEditor, createTilesetFromImage, saveTileset };
}
