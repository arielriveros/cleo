// Worker entry for model import. Dispatches to runImportJob (importJobs.ts) and posts the result
// back, correlated by request id; also emits non-terminal { id, progress } messages before the final
// { id, ok } reply. Keep this file free of DOM imports.

import { runImportJob, ImportJob } from './importJobs';

interface Request {
  id: number;
  job: ImportJob;
}

const ctx: any = self;

ctx.onmessage = async (event: MessageEvent<Request>) => {
  const { id, job } = event.data;
  try {
    const { result, transfer } = await runImportJob(job, (progress, stage) => {
      ctx.postMessage({ id, progress, stage });
    });
    ctx.postMessage({ id, ok: true, result }, transfer);
  } catch (e: any) {
    ctx.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
