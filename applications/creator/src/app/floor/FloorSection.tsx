import { useEffect, useState } from 'react';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { Select } from '@cleo/app-kit/ui';
import { StageSection } from '../workspace';
import type { FloorSet } from './floorSets';
import { floorManifest } from './stageFloor';

const TILE_SPECS: GenericParamSpec[] = [
  { key: 'floorTile', label: 'Tile size', kind: 'float', min: 0.5, max: 8, step: 0.1, unit: 'm' },
];

/**
 * The Stage menu's Floor section: which of the build's PBR sets the ground wears ('' is the plain colour)
 * and how many metres one repeat covers.
 */
export function FloorSection({ set, tile, onChange }: { set: string; tile: number; onChange: (patch: { floorSet?: string; floorTile?: number }) => void }) {
  const [sets, setSets] = useState<FloorSet[] | null>(null);
  useEffect(() => { let live = true; void floorManifest().then(s => { if (live) setSets(s); }); return () => { live = false; }; }, []);
  return (
    <StageSection title='Floor'>
      <Select value={set} onChange={e => onChange({ floorSet: e.target.value })} disabled={!sets?.length}>
        <option value=''>{sets && !sets.length ? 'Plain (no floor sets in this build)' : 'Plain'}</option>
        {(sets ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </Select>
      {set && <ParamForm schema={TILE_SPECS} values={{ floorTile: tile }} onChange={p => onChange(p as { floorTile?: number })} />}
    </StageSection>
  );
}
