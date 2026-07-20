// Worker entry for model import. Dispatches to runImportJob (importJobs.ts) and posts the result back,
// correlated by request id. Keep this file free of DOM imports.
//
// Unlike projectWorker, this one also emits NON-terminal progress messages ({ id, progress }) before
// the final { id, ok } reply — see importClient, which must not settle the pending promise on those.

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
