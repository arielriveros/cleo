import { defineConfig, mergeConfig } from 'vitest/config';
import engineConfig from '../../vite.config';
import { appKitAlias } from './vite.preset';

// The app-kit's own suite: the pure stores and math under the shared chrome (dialogs, toasts, gizmo
// picking and dragging, curve graphs). Same arrangement as the editor's -- node environment, engine
// aliased to source through the shared engine config -- and the same rule: nothing that needs a DOM.
export default mergeConfig(engineConfig, defineConfig({
    resolve: { alias: appKitAlias },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'istanbul',
            reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
            // An explicit allowlist and a ratchet, as in the editor and engine configs. These came over
            // with their tests from the editor's list.
            include: [
                'src/feedback/dialogStore.ts',
                'src/feedback/toastStore.ts',
                'src/gizmo/gizmoDrag.ts',
                'src/gizmo/gizmoHandles.ts',
                'src/gizmo/gizmoPick.ts',
                'src/gizmo/gizmoMath.ts',
            ],
            thresholds: { statements: 90, functions: 90, lines: 90, branches: 78, perFile: false },
        },
    },
}));
