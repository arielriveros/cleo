import ReactDOM from 'react-dom/client';
import DialogHost from '@cleo/app-kit/feedback/DialogHost';
import ToastStack from '@cleo/app-kit/feedback/ToastStack';
import { attachLogStore } from '@cleo/app-kit/feedback/logStore';
import '@cleo/app-kit/styles/theme.css';
import './docsSource';
import App from './app/App';

// Capture logs (and uncaught errors) from the first frame, before the console panel mounts.
attachLogStore();

const root = document.getElementById('root');
if (root) ReactDOM.createRoot(root).render(<><App /><DialogHost /><ToastStack /></>);
