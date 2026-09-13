/**
 * Saved routes, over the host's string key/value store.
 *
 * That store has three properties this has to work around: values are strings,
 * there is no delete, and **keys cannot be enumerated**. So the set of saved
 * routes is tracked in a manifest key, and removing one means clearing its
 * value and dropping its id from that manifest.
 */

import { decodePoints, encodePoints } from './codec.ts'
import type { Path, Waypoint } from './gpx.ts'

export interface KeyValueStore {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<void>
}

/** A route as the app works with it, whether bundled or saved. */
export interface RouteRecord {
  id: string
  name: string
  paths: Path[]
  waypoints: Waypoint[]
  stopNames?: string[]
  restSeconds?: number
  /** Epoch ms of the last import. Absent on routes compiled into the build. */
  updatedAt?: number
  /** Compiled in, so it cannot be deleted. */
  builtIn?: boolean
}

const MANIFEST_KEY = 'routes:index'
const routeKey = (id: string) => `route:${id}`

interface SerializedRoute {
  id: string
  name: string
  paths: { name: string; kind: Path['kind']; points: string }[]
  waypoints: { name: string; lat: number; lon: number; ele?: number }[]
  stopNames?: string[]
  restSeconds?: number
  updatedAt: number
}

export function serializeRoute(route: RouteRecord): string {
  const payload: SerializedRoute = {
    id: route.id,
    name: route.name,
    paths: route.paths.map(path => ({
      name: path.name,
      kind: path.kind,
      points: encodePoints(path.points),
    })),
    waypoints: route.waypoints.map(w => ({
      name: w.name,
      lat: w.point.lat,
      lon: w.point.lon,
      ...(w.point.ele === undefined ? {} : { ele: w.point.ele }),
    })),
    ...(route.stopNames === undefined ? {} : { stopNames: route.stopNames }),
    ...(route.restSeconds === undefined ? {} : { restSeconds: route.restSeconds }),
    updatedAt: route.updatedAt ?? Date.now(),
  }
  return JSON.stringify(payload)
}

/** Null rather than a throw: a half-written value must not break the app. */
export function parseRoute(source: string): RouteRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Partial<SerializedRoute>
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return null
  if (!Array.isArray(record.paths)) return null

  const paths: Path[] = []
  for (const path of record.paths) {
    if (typeof path?.points !== 'string') continue
    const points = decodePoints(path.points)
    if (points.length < 2) continue
    paths.push({
      name: typeof path.name === 'string' ? path.name : '',
      kind: path.kind === 'route' ? 'route' : 'track',
      points,
    })
  }
  if (paths.length === 0) return null

  const waypoints: Waypoint[] = []
  for (const w of Array.isArray(record.waypoints) ? record.waypoints : []) {
    if (!Number.isFinite(w?.lat) || !Number.isFinite(w?.lon)) continue
    waypoints.push({
      name: typeof w.name === 'string' ? w.name : '',
      point: { lat: w.lat, lon: w.lon, ...(Number.isFinite(w.ele) ? { ele: w.ele } : {}) },
    })
  }

  return {
    id: record.id,
    name: record.name,
    paths,
    waypoints,
    ...(Array.isArray(record.stopNames) ? { stopNames: record.stopNames.map(String) } : {}),
    ...(Number.isFinite(record.restSeconds) ? { restSeconds: record.restSeconds } : {}),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
  }
}

async function readManifest(store: KeyValueStore): Promise<string[]> {
  try {
    const raw = JSON.parse(await store.get(MANIFEST_KEY))
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** Saved routes, skipping any whose value is missing or unreadable. */
export async function loadRoutes(store: KeyValueStore): Promise<RouteRecord[]> {
  const routes: RouteRecord[] = []
  for (const id of await readManifest(store)) {
    const parsed = parseRoute(await store.get(routeKey(id)))
    if (parsed !== null) routes.push(parsed)
  }
  return routes
}

/** Insert or replace. Writing the value before the manifest keeps it readable. */
export async function saveRoute(store: KeyValueStore, route: RouteRecord): Promise<void> {
  await store.set(routeKey(route.id), serializeRoute(route))
  const ids = await readManifest(store)
  if (!ids.includes(route.id)) await store.set(MANIFEST_KEY, JSON.stringify([...ids, route.id]))
}

/**
 * Remove a route. The manifest is updated first: the store has no delete, so
 * the value is only blanked, and a route absent from the manifest is gone even
 * if that second write never lands.
 */
export async function deleteRoute(store: KeyValueStore, id: string): Promise<void> {
  const ids = await readManifest(store)
  await store.set(MANIFEST_KEY, JSON.stringify(ids.filter(existing => existing !== id)))
  await store.set(routeKey(id), '')
}

/** A stable id from a name, suffixed if it would collide. */
export function routeIdFor(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'route'
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
}
