import { Popover, Toggle } from '../components/ui';
import { useDebugVisibility, DEBUG_CATEGORIES } from './DebugVisibilityContext';

// Eye glyph matching the inline-SVG style of the viewport's gizmo icons (stroke currentColor).
const EyeIcon = () => (
    <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
        <path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' />
        <circle cx='12' cy='12' r='3' />
    </svg>
);

/**
 * Expandable viewport menu (next to the 2D/3D switch) for toggling debug overlays. Each row is one
 * category with independent Editor and Runtime switches: e.g. Collision on/off while authoring is
 * separate from on/off during Play. State lives in DebugVisibilityContext; the reconcilers react to it.
 *
 * Shown in play mode as well as edit mode, so Runtime toggles can be flipped live during a playtest.
 */
export default function DebugVisibilityMenu() {
    const { visibility, setCategory } = useDebugVisibility();

    return (
        <Popover
            align='right'
            title='Debug overlays'
            triggerClassName='flex items-center justify-center w-[26px] h-[25px] rounded border border-control-hover bg-surface-raised/80 hover:bg-surface-raised text-white cursor-pointer'
            trigger={<EyeIcon />}
            className='min-w-[220px]'
        >
            <div data-cleo-overlay className='p-1'>
                <div className='grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1'>
                    <div className='text-[10px] uppercase tracking-wide text-muted px-1'>Overlay</div>
                    <div className='text-[10px] uppercase tracking-wide text-muted text-center'>Editor</div>
                    <div className='text-[10px] uppercase tracking-wide text-muted text-center'>Runtime</div>
                    {DEBUG_CATEGORIES.map(cat => (
                        <div key={cat.key} className='contents'>
                            <div className='text-xs text-white px-1 py-0.5'>{cat.label}</div>
                            <div className='flex justify-center'>
                                <Toggle checked={visibility[cat.key].editor} onChange={v => setCategory(cat.key, 'editor', v)} />
                            </div>
                            <div className='flex justify-center'>
                                <Toggle
                                    checked={cat.runtimeAvailable && visibility[cat.key].runtime}
                                    disabled={!cat.runtimeAvailable}
                                    onChange={v => setCategory(cat.key, 'runtime', v)}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </Popover>
    );
}
