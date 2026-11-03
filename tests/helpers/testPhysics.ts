// The physics backend this run of the engine suites builds its PhysicsSystems on: cannon, or Rapier in the
// "engine on rapier" project (vitest.config.ts), which runs the suites about engine behaviour a second time.
export const TEST_PHYSICS: string = process.env.CLEO_TEST_PHYSICS ?? 'cannon';
