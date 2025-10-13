import { useEffect, useRef, useState } from 'react';

interface CollapsableProps {
    title: string;
    children: React.ReactNode;
}
export default function Collapsable(props: CollapsableProps) {
    const [collapsed, setCollapsed] = useState(false);
    const contentRef = useRef<HTMLDivElement | null>(null);

    const toggleCollapsed = () => setCollapsed((v) => !v);

    useEffect(() => {
        if (!contentRef.current) return;
        const el = contentRef.current;
        if (collapsed) {
            el.style.maxHeight = '0px';
        } else {
            // Set to scrollHeight for smooth expand
            el.style.maxHeight = el.scrollHeight + 'px';
        }
    }, [collapsed, props.children]);

    // Initialize measured height after mount
    useEffect(() => {
        if (!contentRef.current) return;
        const el = contentRef.current;
        el.style.maxHeight = el.scrollHeight + 'px';
    }, []);

    return (
        <div className={'w-full mb-[10px]'}>
            <div
                className='flex justify-between items-center px-[5px] py-[6px] border-t border-[#2d2d77] rounded-t bg-[#3b3b3b] cursor-pointer select-none'
                onClick={toggleCollapsed}
                role='button'
                aria-expanded={!collapsed}
                aria-controls='collapsable-content'
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed(); } }}
            >
                <div className='text-[16px] font-bold'>{props.title}</div>
                <div className={`text-[14px] transition-transform duration-300 ${collapsed ? '-rotate-90' : ''}`}>▼</div>
            </div>
            <div
                id='collapsable-content'
                ref={contentRef}
                className={`bg-[#202020] overflow-hidden transition-[max-height] duration-300 ease-in-out`}
                style={{ maxHeight: collapsed ? '0px' as any : undefined }}
            >
                {props.children}
            </div>
        </div>
    )
}
