import { useId, useState } from 'react';
import { cn } from './ui/cn';
import { headerClass } from './ui/typography';
import { docTitleAffordance, useDocTooltip } from './ui/DocTooltip';
import { DocRegion, useDocEntry } from '../features/docs/DocScope';

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
    /**
     * Where the docs describe this section, when the title alone does not find it (a dynamic title, or
     * an entry on another page): a term, `page#anchor` or `page[#anchor]::Term`. `false` opts out.
     * The title's hover card is that entry — explanation belongs in the docs, not in a hint here.
     */
    doc?: string | false;
}

const storagePrefix = 'cleo.collapsable.';

export default function Collapsable({ title, children, icon, badge, right, defaultOpen = true, persistKey, className, doc }: CollapsableProps) {
    const contentId = useId();
    const storageKey = persistKey ? storagePrefix + persistKey : null;
    const entry = useDocEntry(title, doc);
    const tip = useDocTooltip(entry);

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
                aria-describedby={tip.describedBy}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
                onFocus={(e) => { if (e.target === e.currentTarget && e.currentTarget.matches(':focus-visible')) tip.show(); }}
                onBlur={tip.hide}
            >
                <span className={cn('text-ui-sm text-muted transition-transform duration-200', open ? '' : '-rotate-90')}>▼</span>
                {/* Sized HERE, not by the glyph: the node-type and UI-type icons (shared with the scene tree) carry no
                    width of their own, and one of them filled the whole card — the "huge" Nav Mesh section. */}
                {icon && <span className='shrink-0 inline-flex w-[15px] h-[15px] text-muted group-hover:text-fg transition-colors [&>svg]:w-full [&>svg]:h-full'>{icon}</span>}
                <span ref={tip.ref} {...tip.hoverProps} className={cn(headerClass, 'truncate', entry && docTitleAffordance)}>{title}</span>
                {tip.card}
                {badge !== undefined && badge !== null && badge !== false && (
                    <span className='shrink-0 min-w-[18px] h-[18px] px-1.5 inline-flex items-center justify-center rounded-full bg-border-subtle text-ui-xs text-muted tabular-nums'>
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
                    <DocRegion entry={entry}>{children}</DocRegion>
                </div>
            </div>
        </div>
    );
}
