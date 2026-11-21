// The repository's test setup for its example projects: the engine, editor and host sources, and the physics
// backends this example's suites also run on (tools/exampleKit/vitestPreset.ts, example.json "tests").
import { exampleVitest } from '../../tools/exampleKit/vitestPreset.ts'

export default exampleVitest(import.meta.url)
