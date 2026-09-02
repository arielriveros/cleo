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
// Nested frames with a corner handle: an anchored rectangle inside a screen, which is what the mode edits.
const UIIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2.5" y="4" width="19" height="16" rx="1.5" />
    <rect x="6" y="7.5" width="8" height="6" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
    <path d="M17 16.5h1.5V18" />
  </svg>
);
const RendererIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
    <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
    <line x1="4" y1="17" x2="20" y2="17" /><circle cx="8" cy="17" r="2" fill="currentColor" stroke="none" />
  </svg>
);

// A gamepad silhouette: two shoulders, a d-pad and two face buttons. Reads as "controller" at 16px,
// which "keyboard" does not.
const InputIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7.5 8h9a4.5 4.5 0 0 1 4.4 3.6l.7 4A2.6 2.6 0 0 1 19 18.5c-.9 0-1.7-.5-2.2-1.2L15.6 15.5H8.4l-1.2 1.8c-.5.7-1.3 1.2-2.2 1.2a2.6 2.6 0 0 1-2.6-2.9l.7-4A4.5 4.5 0 0 1 7.5 8Z" />
    <path d="M7 11v2.2M5.9 12.1h2.2" />
    <circle cx="15.6" cy="11.4" r="1" fill="currentColor" stroke="none" />
    <circle cx="17.6" cy="13.2" r="1" fill="currentColor" stroke="none" />
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
 * Toggleable, icon-based editor-mode selector. Scene/Landscape switch mode directly. Template focuses the
 * Templates bottom panel where you pick or create a template; it highlights only while one is being edited.
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
        {/* Not dimension-gated, unlike the Landscape/Tilemap slot: a HUD applies equally to 2D and 3D. */}
        <Segment active={editorMode === 'ui'} disabled={isPlayMode} title='UI layout & anchoring' onClick={() => select('ui')}>
          <UIIcon /> UI
        </Segment>
        <Segment active={editorMode === 'renderer'} disabled={isPlayMode} title='Renderer options & debug channels' onClick={() => select('renderer')}>
          <RendererIcon /> Renderer
        </Segment>
        {/* Not dimension-gated either: actions are the same on a 2D and a 3D scene. */}
        <Segment active={editorMode === 'input'} disabled={isPlayMode} title='Input actions & bindings' onClick={() => select('input')}>
          <InputIcon /> Input
        </Segment>
      </div>
    </div>
  );
}
