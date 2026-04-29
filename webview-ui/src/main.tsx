import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css'; // Add it here too just to be safe!
import './i18n'; // Initialize i18next BEFORE the first React render

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);