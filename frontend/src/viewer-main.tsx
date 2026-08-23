import { createRoot } from 'react-dom/client';

import { WindowViewer } from './viewer/WindowViewer';
import './viewer.css';

createRoot(document.getElementById('root')!).render(<WindowViewer />);
