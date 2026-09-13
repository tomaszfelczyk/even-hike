import { createRoot } from 'react-dom/client'
import '@jappyjan/even-realities-ui/styles'
import { App } from './ui/App.tsx'
import { setState } from './store.ts'
import { startGlasses } from './glasses.ts'

const container = document.getElementById('app')
if (container !== null) createRoot(container).render(<App />)

/**
 * The page renders first; the glasses attach afterwards and may not be there at
 * all. Outside the Even App WebView this reports `unavailable` immediately, so
 * the phone UI is fully usable in an ordinary browser tab.
 */
const GLASSES_TIMEOUT_MS = 8000
void Promise.race([
  startGlasses(),
  new Promise<'failed'>(resolve => setTimeout(() => resolve('failed'), GLASSES_TIMEOUT_MS)),
])
  .then(glasses => setState({ glasses }))
  .catch((error: unknown) => {
    console.error('glasses connection failed:', error)
    setState({ glasses: 'failed' })
  })
