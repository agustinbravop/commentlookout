import { createRoot, hydrateRoot } from 'react-dom/client';
import './index.css';
import { App } from './landing';
import { Workspace } from './workspace';
import { workspacePaths } from './routes';

if (location.pathname === '/home') location.replace(`/app${location.search}${location.hash}`);
else if (Object.values<string>(workspacePaths).includes(location.pathname)) createRoot(document.getElementById('root')!).render(<Workspace />);
else if (document.getElementById('root')!.hasChildNodes()) hydrateRoot(document.getElementById('root')!, <App />);
else createRoot(document.getElementById('root')!).render(<App />);
