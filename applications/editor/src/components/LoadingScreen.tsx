// The editor's loading screen: app-kit's, branded 'Editor' with the build version and the colour logo.
import SharedLoadingScreen from '@cleo/app-kit/feedback/LoadingScreen'
import type { LoadState } from '@cleo/app-kit/feedback/loadingStore'
// A value import is safe here: version.ts compiles to two string constants and pulls in nothing.
import { VERSION_LABEL } from '../version'

// public/brand/logo.png (tools/brandIcons.mjs), the same file the pre-bundle splash in index.html shows.
const LOGO = `${import.meta.env.BASE_URL}brand/logo.png`

export default function LoadingScreen({ variant = 'fullscreen' }: { variant?: LoadState['variant'] }) {
  return <SharedLoadingScreen variant={variant} subtitle='Editor' versionLabel={VERSION_LABEL} logo={LOGO} />
}
