// Worker entry for the project data pipeline. All it does is dispatch to runJob (projectJobs.ts) and
// post the result back, correlated by request id. Keep this file free of DOM/engine imports.

import { runJob, ProjectJob } from './projectJobs';

interface Request {
  id: number;
  job: ProjectJob;
}

const ctx: any = self;

ctx.onmessage = async (event: MessageEvent<Request>) => {
  const { id, job } = event.data;
  try {
    const { result, transfer } = await runJob(job);
    ctx.postMessage({ id, ok: true, result }, transfer);
  } catch (e: any) {
    ctx.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
