import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// PR 1.1: switched from App.css to globals.css. globals.css imports
// Tailwind, the design tokens, and (transitively) the legacy App.css —
// so unmigrated components still see their .nexus-* class names while
// Sprint 1–3 migrate them to Tailwind utilities. App.css will be
// removed by end of Sprint 3 once no component references it.
import './styles/globals.css';
import './i18n'; // Initialize i18next BEFORE the first React render

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);