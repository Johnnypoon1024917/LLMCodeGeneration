import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css'; // Add it here too just to be safe!

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);