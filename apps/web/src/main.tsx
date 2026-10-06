import { message as uiMessage } from './messages';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import { uiDirection, interfaceLanguage } from './messages';
import './styles.css';
import './plan/plan.css';

const root = document.querySelector('#root');
if (!(root instanceof HTMLElement)) {
  throw new Error(uiMessage('main.973'));
}

document.documentElement.lang = interfaceLanguage;
document.documentElement.dir = uiDirection;
createRoot(root).render(<App />);
