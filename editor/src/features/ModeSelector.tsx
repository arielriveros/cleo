import { useCleoEngine, EditorMode } from "./EngineContext";

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
const TemplateIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3 21 7.5v9L12 21 3 16.5v-9L12 3Z" />
    <path d="M3 7.5 12 12l9-4.5" />
    <path d="M12 12v9" />
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
      className={`flex items-center gap-1 px-2 h-[25px] text-xs border-r border-[#555] last:border-r-0 transition-colors
        ${active ? 'bg-[#2c2cff] text-white' : 'bg-[#3b3b3b] text-[#ccc] hover:bg-[#4a4a4a]'}
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
  const { editorMode, setEditorMode, isPlayMode, eventEmitter } = useCleoEngine();

  const select = (mode: EditorMode) => { if (mode !== editorMode) setEditorMode(mode); };

  return (
    <div className='flex items-center h-full mx-[5px]'>
      <div className='flex items-center rounded overflow-hidden border border-[#555] my-[2px]'>
        <Segment active={editorMode === 'scene'} disabled={isPlayMode} title='Scene editing' onClick={() => select('scene')}>
          <SceneIcon /> Scene
        </Segment>
        <Segment active={editorMode === 'landscape'} disabled={isPlayMode} title='Landscape sculpting' onClick={() => select('landscape')}>
          <LandscapeIcon /> Landscape
        </Segment>
        <Segment active={editorMode === 'template'} disabled={isPlayMode} title='Template editor — pick or create a template in the Templates panel' onClick={() => eventEmitter.emit('FOCUS_BOTTOM_TAB', 'Templates')}>
          <TemplateIcon /> Template
        </Segment>
      </div>
    </div>
  );
}
