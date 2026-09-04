import { defineConfig, mergeConfig } from 'vitest/config';
import engineConfig from './vite.config';

// The engine is overwhelmingly WebGL2-bound and not testable without a GL context. What IS testable is
// the pure math/data core — BVH traversal, ray-triangle intersection, convex hull generation, base64 —
// plus the scene-graph LOGIC (the node lifecycle), which touches no GL of its own even though its module
// graph reaches the renderer. Those are exactly the places where a silent regression is invisible until
// something misbehaves at runtime, so they are where tests earn their keep. Keep this suite free of the
// DOM and of any test that needs a real GL context or an asset fixture.
//
// Editor-side tests live in editor/tests and run under editor/vitest.config.ts. This file is engine-only.
//
// The shader plugin and the `cleo` -> src/cleo.ts alias come from ./vite.config.ts, which everything
// that builds or tests the engine merges — a test, the dev server and a production build then see one
// shader and one set of class identities. The merge is explicit because vitest ignores vite.config.ts
// outright once a vitest.config.ts exists.
export default mergeConfig(engineConfig, defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        coverage: {
            // istanbul, not v8: the v8 provider under this vite version reports branch coverage as a flat
            // 100% (it counts functions in the branch column), which would make the branch floor below a
            // lie. istanbul instruments the source directly and costs a few seconds on a suite this size.
            provider: 'istanbul',
            reporter: ['text', 'text-summary', 'json-summary', 'lcov'],

            // `include` is an explicit allowlist, and it has to be. Three tests import the `cleo` barrel
            // and scene.ts reaches the renderer, so "every file loaded during the run" is effectively the
            // WHOLE engine — thousands of GL-bound lines no node-env test can ever execute. Measured over
            // that, any threshold is theatre. Measured over the modules the tests actually target, it is
            // a real ratchet: these files may not get less tested than they are today.
            //
            // The rule for this list: a module belongs here once it clears the thresholds below. To see
            // what is still outside the gate (and what to write next), run:
            //     npx vitest run --coverage --coverage.include='src/**/*.ts'
            include: [
                'src/audio/soundSettings.ts',
                'src/core/base64.ts',
                'src/ai/aiStats.ts',
                'src/ai/aiSystem.ts',
                'src/ai/fuzzy.ts',
                'src/ai/interop.ts',
                'src/ai/navBake.ts',
                'src/ai/navMesh.ts',
                'src/ai/navPath.ts',
                'src/ai/navSources.ts',
                'src/ai/perception.ts',
                'src/core/cameraRigMath.ts',
                'src/core/conditions.ts',
                'src/core/control/behavior.ts',
                'src/core/control/intent.ts',
                'src/core/control/locomotion.ts',
                'src/core/control/steering.ts',
                'src/core/geometry.ts',
                'src/core/history.ts',
                'src/core/math.ts',
                'src/core/scene/nodes/navMeshNode.ts',
                'src/core/scene/nodes/nodeType.ts',
                'src/core/scene/nodes/parseNodeJson.ts',
                'src/core/scene/nodes/ui/uiContainers.ts',
                'src/core/scene/nodes/ui/uiContent.ts',
                'src/core/scene/nodes/ui/uiNode.ts',
                'src/core/scene/nodes/ui/uiWidgets.ts',
                'src/core/uiLayout.ts',
                'src/animation/animationField.ts',
                'src/animation/boneNames.ts',
                'src/graphics/glContext.ts',
                'src/animation/ik.ts',
                'src/graphics/dofMath.ts',
                'src/graphics/indexFormat.ts',
                'src/graphics/renderGraph/chain.ts',
                'src/graphics/renderGraph/graph.ts',
                'src/graphics/renderGraph/resources.ts',
                'src/graphics/shadowMath.ts',
                'src/animation/skeletonTopology.ts',
                'src/graphics/ssaoKernel.ts',
                'src/graphics/tilemap/cellMath.ts',
                'src/graphics/tilemap/chunk.ts',
                'src/graphics/tilemap/tilemapCollision.ts',
                'src/graphics/tilemap/tilemapLayer.ts',
                'src/graphics/utils/fbxPivots.ts',
                'src/input/actionMap.ts',
                'src/input/gestures.ts',
                'src/input/inputSources.ts',
                'src/input/processors.ts',
                'src/input/resolveActions.ts',
                'src/input/virtualControls.ts',
                'src/physics/cameraRayFilter.ts',
                'src/physics/motion.ts',
            ],

            // Aggregate over the list above, not per file — a single module is allowed a thin patch as
            // long as the set as a whole holds. Measured at the time these were set: statements 93.1,
            // functions 94.3, lines 93.5, branches 76.9.
            //
            // Branches sit at a lower floor on purpose. This code is full of `?? default` and optional
            // serialize fields whose other arm only exists for data written by an older version; 90%
            // there would be bought with tests that assert nothing. It is still a ratchet: it may only
            // ever be raised. The 90% number is the one people mean by "coverage" — statements and lines.
            thresholds: { statements: 90, functions: 90, lines: 90, branches: 75, perFile: false },
        },
    },
}));
