import ReactDOM from 'react-dom/client';
import App from './app';
import { attachLogStore } from './features/logger/logStore';
import { VERSION_LABEL } from './version';
import './index.css';

// Capture logs (and uncaught errors) from the first frame — before the console panel mounts.
attachLogStore();

// First line in the console (and therefore in the editor's own log panel), so a pasted screenshot
// identifies the build it came from.
console.log(`%cCLEO ENGINE%c ${VERSION_LABEL}`, 'font-weight:600;letter-spacing:0.2em', 'color:#94a3b8');

const rootElement = document.getElementById('root');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App />);
}
