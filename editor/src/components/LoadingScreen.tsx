// `import type` so the pre-engine boot gate (app.tsx) can render this without pulling EngineContext — and
// everything it constructs at module scope — into the bundle before a project has been opened.
import type { LoadingProgress } from '../features/EngineContext';
// A value import, unlike the one above: version.ts compiles to two string constants and pulls in nothing.
import { VERSION_LABEL } from '../version';

interface LoadingScreenProps {
  progress: LoadingProgress;
}

// Branded splash shown while the editor loads its startup assets. Mounted inside
// the viewport's `relative` container (Editor.tsx) so it covers only the 3D view
// and leaves the rest of the editor UI visible. Opaque background hides the
// (still empty) canvas behind it.
export default function LoadingScreen({ progress }: LoadingScreenProps) {
  const pct = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-bg text-fg select-none">
      <div className="flex w-[380px] max-w-[85%] flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-[0.3em] text-slate-200">CLEO ENGINE</h1>
          <span className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Editor</span>
          <span className="text-[10px] tabular-nums tracking-[0.2em] text-dim">{VERSION_LABEL}</span>
        </div>

        <div className="w-full">
          <div className="h-2 w-full overflow-hidden rounded-full border border-border bg-surface-sunken">
            <div
              className="h-full rounded-full bg-gradient-to-r from-border to-primary transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
            <span className="truncate">{progress.label || 'Loading…'}</span>
            <span className="tabular-nums text-slate-300">{pct}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
