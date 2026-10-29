// @vitest-environment node
import { describe, it, expect } from 'vitest';

// The model-import worker must be able to LOAD with no DOM. When it cannot, nothing reports it:
// importClient's `onerror` takes the failed start for "no worker available" and re-runs every job inline,
// so imports still work — on the main thread. A 120 MB FBX then froze the editor for over a minute.
// The cause was one import: the `cleo` barrel pulls in howler, whose browser ESM build throws at module
// evaluation in a worker ("HowlerGlobal is not defined"). Node loads howler's CommonJS build instead, so
// the barrel happens to load fine HERE — which is why the second test guards the import itself, and the
// first only proves the worker's own graph needs no DOM.

describe('the import worker', () => {
    it('loads its job module without a DOM', async () => {
        expect(typeof (globalThis as any).window).toBe('undefined');
        const jobs = await import('../src/workers/importJobs');
        expect(typeof jobs.runImportJob).toBe('function');
    });

    it('never imports the `cleo` barrel', async () => {
        const { readFileSync } = await import('fs');
        const source = readFileSync(new URL('../src/workers/importJobs.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/from ['"]cleo['"]/);
    });
});
