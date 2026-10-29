import { Popover, SectionTitle, Toggle } from '@cleo/app-kit/ui';
import { useDebugVisibility, DEBUG_CATEGORIES } from './DebugVisibilityContext';
import { useCleoEngine } from './EngineContext';
import { MODE_SKELETON_OWNER } from './engineContextTypes';

// Eye glyph matching the inline-SVG style of the viewport's gizmo icons (stroke currentColor).
const EyeIcon = () => (
    <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
        <path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' />
        <circle cx='12' cy='12' r='3' />
    </svg>
);

/**
 * Expandable viewport menu (next to the 2D/3D switch) for toggling debug overlays. Each row is one
 * category with independent Editor and Runtime switches; state lives in DebugVisibilityContext. Shown in
 * play mode as well as edit mode, so Runtime toggles can be flipped live during a playtest.
 */
export default function DebugVisibilityMenu() {
    const { visibility, setCategory } = useDebugVisibility();
    const { editorMode } = useCleoEngine();
    // In a skeleton editor the bones are the subject, not a debug aid: they draw whatever this menu says,
    // so their row reads as locked on rather than offering a switch that would do nothing.
    const skeletonLocked = MODE_SKELETON_OWNER[editorMode];
    // Likewise the game UI in UI mode, where it is what is being edited.
    const isLocked = (key: string) => (skeletonLocked && key === 'skeleton') || (editorMode === 'ui' && key === 'gameUi');

    return (
        <Popover
            align='right'
            title='Debug overlays'
            triggerClassName='flex items-center justify-center w-[26px] h-[25px] rounded border border-control-hover bg-surface-raised/80 hover:bg-surface-raised text-fg cursor-pointer'
            trigger={<EyeIcon />}
            className='min-w-[220px]'
        >
            <div data-cleo-overlay className='p-1'>
                <div className='grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1'>
                    {/* Explicit keys: the viewport's docs scope follows the mode, but these are documented in one place. */}
                    <SectionTitle title='Overlay' doc='editor/scene-authoring#debug-overlays::Overlay' className='px-1' />
                    <SectionTitle title='Editor' doc='editor/scene-authoring#debug-overlays::Editor' className='text-center' />
                    <SectionTitle title='Runtime' doc='editor/scene-authoring#debug-overlays::Runtime' className='text-center' />
                    {DEBUG_CATEGORIES.map(cat => {
                        const locked = isLocked(cat.key);
                        return (
                        <div key={cat.key} className='contents'>
                            <div className='text-ui text-fg px-1 py-0.5' title={locked ? 'Always shown in this editor' : undefined}>
                                {cat.label}{locked && <span className='text-muted'> · always on here</span>}
                            </div>
                            <div className='flex justify-center'>
                                <Toggle
                                    checked={locked || visibility[cat.key].editor}
                                    disabled={locked}
                                    onChange={v => setCategory(cat.key, 'editor', v)}
                                />
                            </div>
                            <div className='flex justify-center'>
                                <Toggle
                                    checked={cat.runtimeAvailable && visibility[cat.key].runtime}
                                    disabled={!cat.runtimeAvailable}
                                    onChange={v => setCategory(cat.key, 'runtime', v)}
                                />
                            </div>
                        </div>
                        );
                    })}
                </div>
            </div>
        </Popover>
    );
}
