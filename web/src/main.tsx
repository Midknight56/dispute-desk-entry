import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme } from './theme';
import './app.css';

const scheme = window.matchMedia('(prefers-color-scheme: dark)');
applyTheme(scheme.matches);
scheme.addEventListener('change', (event) => applyTheme(event.matches));

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
