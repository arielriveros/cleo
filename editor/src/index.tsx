import ReactDOM from 'react-dom/client';
import App from './app';
import { attachLogStore } from './features/logger/logStore';
import './index.css';

// Capture logs (and uncaught errors) from the first frame — before the console panel mounts.
attachLogStore();

const rootElement = document.getElementById('root');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(<App />);
}