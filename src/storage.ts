/**
 * One key/value store for both surfaces.
 *
 * On the glasses this is the host store; in a browser tab it falls back to
 * `localStorage`, which is what lets routes be added and removed while
 * developing the phone page without any hardware.
 *
 * Reads wait for the bridge rather than guessing, so the page cannot read
 * `localStorage` and then have the glasses write somewhere else.
 */

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { KeyValueStore } from './lib/route-store.ts'

let settle: (bridge: EvenAppBridge | null) => void
const connected = new Promise<EvenAppBridge | null>(resolve => { settle = resolve })
let decided = false

/** Called once with the bridge, or null when there is no Even App host. */
export function provideBridge(bridge: EvenAppBridge | null): void {
  if (decided) return
  decided = true
  settle(bridge)
}

const local = {
  get(key: string): string {
    try {
      return globalThis.localStorage?.getItem(key) ?? ''
    } catch {
      return ''
    }
  },
  set(key: string, value: string): void {
    try {
      globalThis.localStorage?.setItem(key, value)
    } catch {
      // Private browsing or a full quota. Losing a preview write is acceptable.
    }
  },
}

export const store: KeyValueStore = {
  async get(key) {
    const bridge = await connected
    return bridge === null ? local.get(key) : bridge.getLocalStorage(key)
  },
  async set(key, value) {
    const bridge = await connected
    if (bridge === null) local.set(key, value)
    else await bridge.setLocalStorage(key, value)
  },
}
