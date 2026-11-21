import { useEffect, useState } from 'react';
import { UINode, UIRootNode, declarationOf } from 'cleo';
import Collapsable from '@cleo/app-kit/ui/Collapsable';
import { UI_ICONS, CanvasIcon } from '../../sceneInspector/uiIcons';
import { TransformIcon, AppearanceIcon } from '../sectionIcons';
import { DocScope } from '@cleo/app-kit/ui';
import { useEventBus } from '../../EventBusContext';
import { DeclaredSection } from '../../properties/DeclaredSections';

/**
 * The inspector for every UI element type: each type's own fields (its Element card, a root's Canvas), and the
 * Anchor & Rect and Appearance every element shares, all declared (src/properties/ui.ts). The anchors' grid of
 * presets is the card's own.
 */

/** Re-render this panel whenever the node changes, including from a script or an undo. */
function useNodeVersion(node: UINode): () => void {
    const eventEmitter = useEventBus();
    const [, setTick] = useState(0);
    const bump = () => setTick(t => t + 1);
    useEffect(() => {
        const onChanged = () => setTick(t => t + 1);
        eventEmitter.on('SCENE_CHANGED', onChanged);
        return () => { eventEmitter.off('SCENE_CHANGED', onChanged); };
    }, [eventEmitter]);
    return bump;
}

/** The nine pins plus the four stretch modes, as anchorMin/anchorMax pairs. */
const ANCHOR_PRESETS: { key: string, title: string, min: [number, number], max: [number, number] }[] = [
    { key: 'tl', title: 'Top left', min: [0, 0], max: [0, 0] },
    { key: 'tc', title: 'Top center', min: [0.5, 0], max: [0.5, 0] },
    { key: 'tr', title: 'Top right', min: [1, 0], max: [1, 0] },
    { key: 'sh-t', title: 'Stretch horizontally, top', min: [0, 0], max: [1, 0] },
    { key: 'ml', title: 'Middle left', min: [0, 0.5], max: [0, 0.5] },
    { key: 'mc', title: 'Center', min: [0.5, 0.5], max: [0.5, 0.5] },
    { key: 'mr', title: 'Middle right', min: [1, 0.5], max: [1, 0.5] },
    { key: 'sh-m', title: 'Stretch horizontally, middle', min: [0, 0.5], max: [1, 0.5] },
    { key: 'bl', title: 'Bottom left', min: [0, 1], max: [0, 1] },
    { key: 'bc', title: 'Bottom center', min: [0.5, 1], max: [0.5, 1] },
    { key: 'br', title: 'Bottom right', min: [1, 1], max: [1, 1] },
    { key: 'sh-b', title: 'Stretch horizontally, bottom', min: [0, 1], max: [1, 1] },
    { key: 'sv-l', title: 'Stretch vertically, left', min: [0, 0], max: [0, 1] },
    { key: 'sv-c', title: 'Stretch vertically, center', min: [0.5, 0], max: [0.5, 1] },
    { key: 'sv-r', title: 'Stretch vertically, right', min: [1, 0], max: [1, 1] },
    { key: 'fill', title: 'Stretch both', min: [0, 0], max: [1, 1] },
];

/** A tiny diagram of what each preset does, so the grid is readable without hovering every cell. */
function AnchorGlyph({ min, max }: { min: [number, number], max: [number, number] }) {
    const stretchX = min[0] !== max[0];
    const stretchY = min[1] !== max[1];
    const x = stretchX ? 3 : 3 + min[0] * 12;
    const y = stretchY ? 3 : 3 + min[1] * 12;
    const w = stretchX ? 12 : 3;
    const h = stretchY ? 12 : 3;
    return (
        <svg viewBox="0 0 18 18" width="18" height="18">
            <rect x="1" y="1" width="16" height="16" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.35" />
            <rect x={x} y={y} width={w} height={h} rx="0.8" fill="currentColor" />
        </svg>
    );
}

function AnchorPicker({ node, onChange }: { node: UINode, onChange: () => void }) {
    const active = ANCHOR_PRESETS.find(p =>
        p.min[0] === node.anchorMin[0] && p.min[1] === node.anchorMin[1] &&
        p.max[0] === node.anchorMax[0] && p.max[1] === node.anchorMax[1]);

    return (
        <div className='grid grid-cols-4 gap-1 p-1'>
            {ANCHOR_PRESETS.map(preset => (
                <button
                    key={preset.key}
                    type='button'
                    title={preset.title}
                    className={`flex items-center justify-center h-7 rounded border transition-colors ${
                        active?.key === preset.key
                            ? 'bg-selected border-fg text-fg'
                            : 'bg-control border-control text-muted hover:bg-control-hover hover:text-fg'}`}
                    onClick={() => {
                        node.anchorMin = [...preset.min] as [number, number];
                        node.anchorMax = [...preset.max] as [number, number];
                        onChange();
                    }}>
                    <AnchorGlyph min={preset.min} max={preset.max} />
                </button>
            ))}
        </div>
    );
}

export default function UIEditor({ node }: { node: UINode }) {
    const bump = useNodeVersion(node);

    // A root's rect comes from the viewport or its projection, so anchor/offset do not apply to it.
    const isRoot = node instanceof UIRootNode;
    const TypeIcon = UI_ICONS[node.nodeType] ?? CanvasIcon;

    // Each type's fields are documented under its own heading of the UI page (a panel has none of its own).
    const own = declarationOf(node);
    const payload = own && own.title !== 'Appearance' ? own : null;
    const payloadDoc = payload ? `${payload.docs}#${payload.docsSection}` : 'editor/ui#element-types';
    const body = <div className='w-full p-2'>{payload && <DeclaredSection node={node} title='' />}</div>;

    // Documented on the UI page. The payload card is two literal titles rather than one chosen by type, so
    // each names its own docs entry.
    return (
        <DocScope page='editor/ui'>
            {isRoot
                ? <Collapsable title='Canvas' doc='editor/ui#canvases' icon={<TypeIcon />} persistKey='ui-payload'>{body}</Collapsable>
                : <Collapsable title='Element' doc={payloadDoc} icon={<TypeIcon />} persistKey='ui-payload'>{body}</Collapsable>}

            {!isRoot && (
                <Collapsable title='Anchor & Rect' doc='editor/ui#anchors-and-rectangles' icon={<TransformIcon />} persistKey='ui-rect'>
                    <div className='w-full p-2'>
                        <AnchorPicker node={node} onChange={bump} />
                        <DeclaredSection node={node} of={UINode} title='Anchors and rectangles' bare />
                    </div>
                </Collapsable>
            )}

            <Collapsable title='Appearance' icon={<AppearanceIcon />} persistKey='ui-appearance'>
                <div className='w-full p-2'><DeclaredSection node={node} of={UINode} title='' /></div>
            </Collapsable>
        </DocScope>
    );
}
