import ReactDOM from 'react-dom/client';
import DialogHost from '@cleo/app-kit/feedback/DialogHost';
import ToastStack from '@cleo/app-kit/feedback/ToastStack';
import LoadingScreen from '@cleo/app-kit/feedback/LoadingScreen';
import { attachLogStore } from '@cleo/app-kit/feedback/logStore';
import { DocsViewerHost } from '@cleo/app-kit/docs/viewer/DocsViewerHost';
import '@cleo/app-kit/styles/theme.css';
import './docsSource';
import App from './app/App';
import { bootLoad, LOGO, LOGO_PIXELS } from './app/bootLoad';
import { settleEditorLibrary } from './app/editorLibrary';

// Capture logs (and uncaught errors) from the first frame, before the console panel mounts.
attachLogStore();
// Begun before the first render, so the engine and the sub-app chunk both report into the one load.
bootLoad();

// The Creator library first: on its own site, the Creator reaches the editor's through a frame, and nothing may read
// or write the library before that is settled (a no-op on the editor's origin).
const root = document.getElementById('root');
if (root) void settleEditorLibrary().then(() => ReactDOM.createRoot(root).render(<>
  <App />
  <LoadingScreen variant='fullscreen' subtitle='Creator' logo={LOGO} logoPixels={LOGO_PIXELS} />
  <DialogHost />
  <ToastStack />
  {/* Help > Documentation, F1 and What's This?, on every page including Home. */}
  <DocsViewerHost home='creator/index' storageKey='cleo_creator_docs_window' />
</>));
