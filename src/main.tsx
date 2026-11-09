import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './landing';
import { Workspace } from './workspace';

if (location.pathname === '/app') location.replace('/home');
else createRoot(document.getElementById('root')!).render(location.pathname === '/home' ? <Workspace /> : <App />);
