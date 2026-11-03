// The physics backend this run of the engine suites builds its PhysicsSystems on: cannon, or another backend
// in its "engine on <backend>" project (vitest.config.ts), which runs the suites about engine behaviour again.
export const TEST_PHYSICS: string = process.env.CLEO_TEST_PHYSICS ?? 'cannon';
