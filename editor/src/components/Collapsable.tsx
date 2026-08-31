import { useId, useState } from 'react';
import { cn } from './ui/cn';
import { headerClass } from './ui/typography';
import { hintAffordance } from './ui/Field';

interface CollapsableProps {
    title: string;
    children: React.ReactNode;
    /** Small glyph shown before the title. */
    icon?: React.ReactNode;
    /** Count/label pill shown after the title (e.g. shape or uniform count). */
    badge?: React.ReactNode;
    /** Header-right actions (buttons); clicks here don't toggle the section. */
    right?: React.ReactNode;
    defaultOpen?: boolean;
    /** When set, the open/closed state is remembered in localStorage under this key. */
    persistKey?: string;
    className?: string;
    /** Native tooltip on the header, for explanation that covers the whole panel rather than one control. */
    hint?: string;
}

const storagePrefix = 'cleo.collapsable.';

export default function Collapsable({ title, children, icon, badge, right, defaultOpen = true, persistKey, className, hint }: CollapsableProps) {
    const contentId = useId();
    const storageKey = persistKey ? storagePrefix + persistKey : null;

    const [open, setOpen] = useState<boolean>(() => {
        if (storageKey) {
            try { const v = localStorage.getItem(storageKey); if (v != null) return v === '1'; } catch { /* ignore */ }
        }
        return defaultOpen;
    });

    const toggle = () => setOpen((prev) => {
        const next = !prev;
        if (storageKey) { try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* ignore */ } }
        return next;
    });

    return (
        <div className={cn('w-full mb-2', className)}>
            <div
                className='group flex items-center gap-2 px-2 py-1.5 border-t border-border rounded-t bg-control hover:bg-control-hover cursor-pointer select-none transition-colors'
                onClick={toggle}
                role='button'
                aria-expanded={open}
                aria-controls={contentId}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
            >
                <span className={cn('text-[11px] text-muted transition-transform duration-200', open ? '' : '-rotate-90')}>▼</span>
                {icon && <span className='shrink-0 text-muted group-hover:text-white transition-colors'>{icon}</span>}
                <span className={cn(headerClass, 'truncate', hintAffordance(hint))} title={hint}>{title}</span>
                {badge !== undefined && badge !== null && badge !== false && (
                    <span className='shrink-0 min-w-[18px] h-[18px] px-1.5 inline-flex items-center justify-center rounded-full bg-border-subtle text-[10px] text-muted tabular-nums'>
                        {badge}
                    </span>
                )}
                <span className='flex-1' />
                {right && <span onClick={(e) => e.stopPropagation()} className='shrink-0 flex items-center gap-1'>{right}</span>}
            </div>
            <div
                id={contentId}
                className='grid transition-[grid-template-rows] duration-300 ease-in-out'
                style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
            >
                <div className='overflow-hidden bg-surface-raised'>
                    {children}
                </div>
            </div>
        </div>
    );
}
