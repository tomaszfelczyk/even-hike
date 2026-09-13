/**
 * The little state both surfaces share.
 *
 * The phone page and the glasses are two views of one app, so the chosen route
 * and the rest log live here rather than in either of them. React subscribes
 * with `useSyncExternalStore`; the glasses controller subscribes directly.
 */

import { BUILT_IN_ROUTES } from './routes.ts'
import type { Rest } from './lib/rests.ts'
import type { RouteRecord } from './lib/route-store.ts'

export type GlassesStatus = 'connecting' | 'ready' | 'unavailable' | 'failed'

export interface AppState {
  /** Built-ins first, then anything imported. */
  routes: RouteRecord[]
  routeId: string
  glasses: GlassesStatus
  /** Populated once the glasses controller has loaded the route's log. */
  rests: Rest[]
}

let state: AppState = {
  routes: BUILT_IN_ROUTES,
  routeId: BUILT_IN_ROUTES[0].id,
  glasses: 'connecting',
  rests: [],
}

type Listener = () => void
let listeners: Listener[] = []

export const getState = (): AppState => state

export function setState(patch: Partial<AppState>): void {
  const next = { ...state, ...patch }
  // Reference equality is what useSyncExternalStore compares, so skip no-op
  // writes rather than forcing a render on every GPS tick.
  if ((Object.keys(patch) as (keyof AppState)[]).every(key => next[key] === state[key])) return
  state = next
  for (const listener of listeners) listener()
}

export function subscribe(listener: Listener): () => void {
  listeners = [...listeners, listener]
  return () => { listeners = listeners.filter(l => l !== listener) }
}
