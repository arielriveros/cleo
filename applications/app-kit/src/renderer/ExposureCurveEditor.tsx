import { exposureCurveStops, type CurveKey, type ExposureCurveKey } from 'cleo';
import { Button, CurveGraph, DocHover, cn, labelClass, snapGraphValue, useDocEntry } from '../ui';

export interface ExposureCurveEditorProps {
  value: ExposureCurveKey[];
  onChange: (value: ExposureCurveKey[]) => void;
  labelClassName?: string;
  /** The EV the meter reads now, drawn as a line so a key can be put where the scene actually sits. */
  meteredEV?: number;
}

/** The EV100 span the graph opens on: what the Min / Max EV sliders allow. Keys outside widen it. */
const EV_DOMAIN: [number, number] = [-4, 20];
const EV_TICKS = [-4, 0, 4, 8, 12, 16, 20];
/** Drag steps: half an EV across, a quarter stop up. */
const SNAP = { x: 0.5, y: 0.25 };

/** `[ev, stops]` keys as graph keys. */
export function curveToGraphKeys(curve: readonly ExposureCurveKey[]): CurveKey[] {
  return curve.map(([ev, stops]) => ({ t: ev, v: stops }));
}

/** Graph keys back as `[ev, stops]`, sorted by EV and on the snap grid's decimals. */
export function graphKeysToCurve(keys: readonly CurveKey[]): ExposureCurveKey[] {
  return [...keys].sort((a, b) => a.t - b.t).map(k => [snapGraphValue(k.t), snapGraphValue(k.v)] as ExposureCurveKey);
}

/**
 * The exposure compensation curve as a graph: metered scene EV100 across, stops of compensation up. Linear
 * between keys and held flat past the ends, exactly as `exposureCurveStops` applies it, so what is drawn is
 * what the renderer does. An empty curve is the flat zero line: no trim anywhere.
 */
export function ExposureCurveEditor({ value, onChange, labelClassName, meteredEV }: ExposureCurveEditorProps) {
  const entry = useDocEntry('Compensation curve', undefined, 'field');
  return (
    <div className='flex flex-col gap-1 my-1'>
      <div className='flex items-center justify-between gap-2'>
        <DocHover entry={entry} affordance='field' className={cn(labelClass, 'shrink-0', labelClassName)}>
          Compensation curve
        </DocHover>
        <Button size='sm' disabled={value.length === 0} title='Remove every key: no trim at any EV'
          onClick={() => onChange([])}>Clear</Button>
      </div>
      <CurveGraph
        keys={curveToGraphKeys(value)}
        onChange={(keys) => onChange(graphKeysToCurve(keys))}
        evaluate={(ev) => exposureCurveStops(value, ev)}
        linear
        domain={EV_DOMAIN}
        xTicks={EV_TICKS}
        min={-4}
        max={4}
        zeroLine
        xLabel='Scene EV'
        yLabel='Stops'
        snap={SNAP}
        allowEmpty
        keyLabels={['EV', 'stops']}
        presets={[]}
        marker={meteredEV !== undefined && Number.isFinite(meteredEV) ? { x: meteredEV, label: `now ${meteredEV.toFixed(1)}` } : undefined} />
    </div>
  );
}

export default ExposureCurveEditor;
