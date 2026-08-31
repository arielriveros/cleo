import React, { useState } from 'react';

/** What to spread onto the element that accepts the drop. */
export interface AssetDropProps {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
}

export interface AssetDropOptions {
    /** Set `dataTransfer.dropEffect` while hovering, so the cursor shows the intent. */
    dropEffect?: 'copy' | 'move' | 'link';
    /** Stop the drop bubbling to an outer drop target. */
    stopPropagation?: boolean;
}

/**
 * Accept a drag of one asset kind, identified by its `text/cleo-*` MIME type. `onAssign` receives the
 * dragged asset's id. `dragOver` is true only while a drag carrying that exact type is over the target,
 * so a drag of any other kind neither highlights nor drops.
 */
export function useAssetDrop(
    mime: string,
    onAssign: (id: string) => void,
    options: AssetDropOptions = {},
): { dragOver: boolean; dropProps: AssetDropProps } {
    const [dragOver, setDragOver] = useState(false);
    return {
        dragOver,
        dropProps: {
            onDragOver: (e: React.DragEvent) => {
                if (!e.dataTransfer.types.includes(mime)) return;
                e.preventDefault();
                if (options.dropEffect) e.dataTransfer.dropEffect = options.dropEffect;
                setDragOver(true);
            },
            onDragLeave: () => setDragOver(false),
            onDrop: (e: React.DragEvent) => {
                e.preventDefault();
                if (options.stopPropagation) e.stopPropagation();
                setDragOver(false);
                const id = e.dataTransfer.getData(mime);
                if (id) onAssign(id);
            },
        },
    };
}

export default useAssetDrop;
