import { useEffect, useRef } from 'react';
import { cn } from '@cleo/app-kit/ui';
import { hullEntryState, toggleHullEntry, type HullSourceEntry } from '../../../utils/hullSources';

/** A checkbox that is on, off, or part-way (some of what is under it is on). */
function TriCheckbox(props: { state: 'all' | 'some' | 'none'; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = props.state === 'some'; }, [props.state]);
  return (
    <input ref={ref} type='checkbox' className='shrink-0 accent-primary' checked={props.state === 'all'}
      onChange={props.onToggle} />
  );
}

/** How many of the tree's entries hold a mesh of their own. */
export const hullMeshCount = (tree: readonly HullSourceEntry[]) => tree.reduce((n, e) => n + (e.mesh ? 1 : 0), 0);

/**
 * Which meshes a convex hull is built from: the node's tree of meshes (hullSourceTree), a checkbox each,
 * indented under what they are under. Checking a node checks everything under it; a node with some of its
 * meshes in shows part-way. `included` is the paths of the meshes in.
 */
export function HullMeshPicker(props: {
  tree: readonly HullSourceEntry[];
  included: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  className?: string;
}) {
  const { tree, included } = props;
  return (
    <div className={cn('max-h-44 overflow-y-auto rounded border border-border-subtle py-0.5', props.className)}>
      {tree.map((e, i) => {
        const group = i + 1 < tree.length && tree[i + 1].depth > e.depth;
        const title = group
          ? `Build the hull from ${e.mesh ? `${e.name} and ` : ''}every mesh under ${e.name}`
          : `Build the hull from ${e.name}`;
        return (
          <label key={e.path || '.'} title={title}
            className='flex items-center gap-1.5 pr-1 py-px text-ui select-none cursor-pointer rounded-sm hover:bg-highlight/10'
            style={{ paddingLeft: 4 + e.depth * 14 }}>
            <TriCheckbox state={hullEntryState(tree, i, included)} onToggle={() => props.onChange(toggleHullEntry(tree, i, included))} />
            <span className={cn('truncate', !e.mesh && 'text-muted')}>{e.name}</span>
          </label>
        );
      })}
    </div>
  );
}

export default HullMeshPicker;
