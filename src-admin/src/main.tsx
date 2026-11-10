import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

window.adapterName = 'smart-text2command';
const root = document.getElementById('root');
if (root) createRoot(root).render(<App adapterName="smart-text2command" />);
