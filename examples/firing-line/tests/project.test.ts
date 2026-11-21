// The checks every example project is held to (tools/exampleKit/specs/project.ts). Its placed fighters (FPS Bot,
// its variants, FPS Player) carry their own weapon meshes, ragdoll and controller actions that their templates
// predate; opening the scene does not rebuild them (its hashes are current), so they keep them.
import { projectSpecs } from '@tools/exampleKit/specs/project'

projectSpecs({ staticColliders: true, knownDivergent: ['FPS Bot', 'FPS Vanguard', 'FPS Raider', 'FPS Swat', 'FPS Player'] })
