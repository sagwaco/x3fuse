import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n/config'
import App from './App'
import './index.css'

document.documentElement.dataset.platform = window.x3f.platform

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
