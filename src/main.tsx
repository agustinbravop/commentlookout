import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './landing';
import { Workspace } from './workspace';
import { workspacePaths } from './routes';

if (location.pathname === '/home') location.replace(`/app${location.search}${location.hash}`);
else createRoot(document.getElementById('root')!).render(Object.values<string>(workspacePaths).includes(location.pathname) ? <Workspace /> : <App />);
