import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { provideVSCodeDesignSystem, vsCodeButton, vsCodeTextArea, vsCodeProgressRing } from '@vscode/webview-ui-toolkit';

// Register toolkit components
provideVSCodeDesignSystem().register(vsCodeButton(), vsCodeTextArea(), vsCodeProgressRing());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);