import { defineConfig, mergeConfig } from 'vite';
import engineConfig from '../../vite.config';
import { appKitAlias } from '../app-kit/vite.preset';

// The host runs engine and player source directly (vite-node), resolved the way the editor's own tests resolve
// them: `cleo` is src/cleo.ts, shaders load as text, and `@cleo/app-kit/*` is the app-kit's source.
export default mergeConfig(engineConfig, defineConfig({
    resolve: { alias: appKitAlias },
}));
