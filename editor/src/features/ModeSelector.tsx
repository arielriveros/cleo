import { useCleoEngine, EditorMode } from "./EngineContext";
import { useProject } from "./ProjectContext";

// Inline SVG glyphs (stroke currentColor) so no binary icon assets are needed.
const SceneIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3 21 8 12 13 3 8 12 3Z" />
    <path d="M3 12 12 17 21 12" />
    <path d="M3 16 12 21 21 16" />
  </svg>
);
const LandscapeIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 19 9 8l4 6 2-3 6 8Z" />
    <circle cx="17" cy="6" r="2" />
  </svg>
);
// A sliced grid with one cell filled — the same shape as the tileset asset icon, so the mode and the
// assets it paints from read as one thing.
const TilemapIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
    <path d="M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17" />
    <rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" />
  </svg>
);
const RendererIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
    <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
    <line x1="4" y1="17" x2="20" y2="17" /><circle cx="8" cy="17" r="2" fill="currentColor" stroke="none" />
  </svg>
);

interface SegmentProps {
  active: boolean;
  disabled: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}
function Segment({ active, disabled, title, onClick, children }: SegmentProps) {
  return (
    <button
      className={`flex items-center gap-1 px-2 h-[25px] text-xs border-r border-control-hover last:border-r-0 transition-colors
        ${active ? 'bg-selected text-white' : 'bg-control text-muted hover:bg-control-hover'}
        ${disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * Toggleable, icon-based editor-mode selector. Scene/Landscape switch mode directly (leaving
 * template mode auto-saves). Template focuses the Templates bottom panel where you pick/create a
 * template to edit; it only highlights while a template is actually being edited.
 */
export default function ModeSelector() {
  const { editorMode, setEditorMode, isPlayMode, activeTab } = useCleoEngine();
  const { sceneDimension } = useProject();

  const select = (mode: EditorMode) => { if (mode !== editorMode) setEditorMode(mode); };

  // The scene/sculpt/renderer switch belongs to the scene tab; asset tabs hide it.
  if (activeTab.kind !== 'scene') return null;

  // Landscape and Tilemap are the same slot, filled by whichever one the open scene's dimension uses.
  // Offering both would mean offering a tool that cannot render anything in the current scene.
  const is2D = sceneDimension === '2D';

  return (
    <div className='flex items-center h-full mx-[5px]'>
      <div className='flex items-center rounded overflow-hidden border border-control-hover my-[2px]'>
        <Segment active={editorMode === 'scene'} disabled={isPlayMode} title='Scene editing' onClick={() => select('scene')}>
          <SceneIcon /> Scene
        </Segment>
        {is2D ? (
          <Segment active={editorMode === 'tilemap'} disabled={isPlayMode} title='Tile painting' onClick={() => select('tilemap')}>
            <TilemapIcon /> Tilemap
          </Segment>
        ) : (
          <Segment active={editorMode === 'landscape'} disabled={isPlayMode} title='Landscape sculpting' onClick={() => select('landscape')}>
            <LandscapeIcon /> Landscape
          </Segment>
        )}
        <Segment active={editorMode === 'renderer'} disabled={isPlayMode} title='Renderer options & debug channels' onClick={() => select('renderer')}>
          <RendererIcon /> Renderer
        </Segment>
      </div>
    </div>
  );
}
