import ReactDOM from 'react-dom/client';
import DialogHost from '@cleo/app-kit/feedback/DialogHost';
import ToastStack from '@cleo/app-kit/feedback/ToastStack';
import LoadingScreen from '@cleo/app-kit/feedback/LoadingScreen';
import { attachLogStore } from '@cleo/app-kit/feedback/logStore';
import '@cleo/app-kit/styles/theme.css';
import './docsSource';
import App from './app/App';
import { bootLoad } from './app/bootLoad';

// Capture logs (and uncaught errors) from the first frame, before the console panel mounts.
attachLogStore();
// Begun before the first render, so the engine and the sub-app chunk both report into the one load.
bootLoad();

const root = document.getElementById('root');
if (root) ReactDOM.createRoot(root).render(<><App /><LoadingScreen variant='fullscreen' subtitle='Creator' /><DialogHost /><ToastStack /></>);
