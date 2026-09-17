import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Api } from './api'
import './styles.css'

let api: Api
let configError = false
try { api = new Api(import.meta.env.VITE_API_ORIGIN ?? '') }
catch { api = new Api(); configError = true }
createRoot(document.getElementById('root')!).render(<StrictMode><App api={api} configError={configError} /></StrictMode>)

// This app is deployed on its own origin. Registration never touches existing workers.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // The online app remains usable if installation or storage is unavailable.
    })
  })
}
