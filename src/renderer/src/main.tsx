import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { I18nProvider } from './i18n'
import './theme.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <ErrorBoundary labelKey="error.boundaryApp">
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>
)
