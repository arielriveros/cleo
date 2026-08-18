// Compact frame-time graph. Deliberately an inline SVG polyline rather than a canvas: the series is
// at most a few hundred points redrawn ~4 times a second, so the DOM cost is irrelevant and the
// result scales crisply with the panel and inherits theme colours from CSS variables.

type Props = {
  /** Series, oldest first. */
  values: number[];
  /** Height in px. Width is fluid. */
  height?: number;
  /**
   * Frame-time budget in ms. Drawn as a horizontal reference line, and anything above it is tinted
   * with the danger colour — which is the entire reason this graph exists: "are we under budget"
   * is a yes/no question that a bare number answers far less quickly than a line crossing a rule.
   */
  budgetMs?: number;
  /** Optional fixed ceiling; otherwise the graph autoscales to the series max. */
  maxMs?: number;
  className?: string;
};

export default function Sparkline({ values, height = 40, budgetMs, maxMs, className }: Props) {
  if (values.length < 2) {
    return <div className={`text-muted text-[10px] ${className ?? ''}`} style={{ height }}>collecting…</div>;
  }

  // Autoscale with a little headroom, but never below the budget line — otherwise a comfortably
  // fast series would rescale until it looked like it was grazing the limit.
  const seriesMax = Math.max(...values);
  const top = maxMs ?? Math.max(seriesMax * 1.15, (budgetMs ?? 0) * 1.3, 1);

  const W = 100; // viewBox units; preserveAspectRatio=none stretches to the real width
  const H = 100;
  const step = W / (values.length - 1);
  const y = (v: number) => H - Math.min(1, v / top) * H;

  const points = values.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const budgetY = budgetMs ? y(budgetMs) : null;
  // Same 5% slack as the numeric readout: a vsynced frame lands exactly on the budget, and colouring
  // that red would mean a machine hitting its refresh rate perfectly still looks like it is failing.
  const over = budgetMs != null && values[values.length - 1] > budgetMs * 1.05;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio='none'
      style={{ height, width: '100%', display: 'block' }}
      role='img'
      aria-label={`Frame time, latest ${values[values.length - 1].toFixed(1)} ms`}
    >
      {budgetY != null && (
        <line
          x1={0} x2={W} y1={budgetY} y2={budgetY}
          stroke='currentColor' strokeWidth={0.5} strokeDasharray='2 2' opacity={0.45}
          vectorEffect='non-scaling-stroke'
        />
      )}
      <polyline
        points={points}
        fill='none'
        strokeWidth={1.2}
        vectorEffect='non-scaling-stroke'
        className={over ? 'text-danger' : 'text-success'}
        stroke='currentColor'
      />
    </svg>
  );
}
