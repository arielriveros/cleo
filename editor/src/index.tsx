import ReactDOM from 'react-dom/client';
import App from './app';
import DialogHost from './features/dialogs/DialogHost';
import ToastStack from './features/toasts/ToastStack';
import { attachLogStore } from './features/logger/logStore';
import { VERSION_LABEL } from './version';
import './index.css';

// Capture logs (and uncaught errors) from the first frame — before the console panel mounts.
attachLogStore();

// First line in the console, so a pasted screenshot identifies the build it came from.
console.log(`%cCLEO ENGINE%c ${VERSION_LABEL}`, 'font-weight:600;letter-spacing:0.2em', 'color:#94a3b8');

const rootElement = document.getElementById('root');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    // The two global notice surfaces sit OUTSIDE <App> on purpose. App returns from four separate boot
    // branches, and the launcher one (ProjectsBrowser -> ProjectsExplorer / ExamplesGallery) renders
    // outside EngineProvider, VfsProvider and Editor -- yet still has to confirm a project delete. Both
    // read module-level stores, need no context, and render null when there is nothing to show, so
    // mounting them here means a parked promise always has a renderer, in every phase.
    root.render(<><App /><DialogHost /><ToastStack /></>);
}
