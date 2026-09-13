/**
 * Hikes as they happened: where you actually went, and where you stopped.
 *
 * Separate from a route, which is the plan. A session is the record — the trace
 * walked, the rests taken, how long it took — and comparing the two is the
 * whole point of keeping it.
 *
 * Size is the thing to watch. A route is stored at full density because
 * navigation projects onto it; a trace is only ever reviewed, so points closer
 * together than `TRACE_SPACING_M` are dropped as they arrive. On a 20 km walk
 * that is the difference between ~14 KB and ~6 KB per hike, and hikes
 * accumulate forever while routes do not.
 */

import { decodePoints, encodePoints } from './codec.ts'
import { haversine, pathLength, type LatLon, type RoutePoint } from './geo.ts'
import type { KeyValueStore } from './route-store.ts'
import { parseRests, serializeRests, totalRestMs, type Rest } from './rests.ts'

/** Minimum gap between recorded trace points. */
export const TRACE_SPACING_M = 25

export interface HikeSession {
  id: string
  routeId: string
  /** Copied in, so history still reads properly after a route is deleted. */
  routeName: string
  startedAt: number
  /** Null while the hike is still in progress. */
  endedAt: number | null
  /** The trace actually walked. */
  track: RoutePoint[]
  rests: Rest[]
}

const MANIFEST_KEY = 'hikes:index'
const sessionKey = (id: string) => `hike:${id}`

export const sessionIdFor = (routeId: string, startedAt: number) => `${routeId}-${startedAt}`

export function startSession(routeId: string, routeName: string, now: number): HikeSession {
  return {
    id: sessionIdFor(routeId, now),
    routeId,
    routeName,
    startedAt: now,
    endedAt: null,
    track: [],
    rests: [],
  }
}

/**
 * Append a fix, or return the session unchanged when it adds nothing.
 *
 * Returning the same object on a no-op lets callers skip a write by identity,
 * which matters when fixes arrive every few metres for hours.
 */
export function recordFix(
  session: HikeSession,
  position: LatLon,
  options: { spacingM?: number; ele?: number } = {},
): HikeSession {
  const spacing = options.spacingM ?? TRACE_SPACING_M
  const last = session.track[session.track.length - 1]
  if (last !== undefined && haversine(last, position) < spacing) return session

  const point: RoutePoint = options.ele === undefined
    ? { lat: position.lat, lon: position.lon }
    : { lat: position.lat, lon: position.lon, ele: options.ele }
  return { ...session, track: [...session.track, point] }
}

export const endSession = (session: HikeSession, now: number): HikeSession =>
  session.endedAt !== null ? session : { ...session, endedAt: Math.max(session.startedAt, now) }

/** Metres actually walked, from the trace rather than from the plan. */
export const walkedDistance = (session: HikeSession): number => pathLength(session.track)

/** Wall-clock length of the hike, including rest. */
export const elapsedMs = (session: HikeSession, now: number): number =>
  Math.max(0, (session.endedAt ?? now) - session.startedAt)

/** Time on the move: elapsed less the rests recorded inside it. */
export const movingMs = (session: HikeSession, now: number): number =>
  Math.max(0, elapsedMs(session, now) - totalRestMs(session.rests, now))

/* ---------- persistence ---------- */

interface SerializedSession {
  id: string
  routeId: string
  routeName: string
  startedAt: number
  endedAt: number | null
  track: string
  rests: string
}

export function serializeSession(session: HikeSession): string {
  const payload: SerializedSession = {
    id: session.id,
    routeId: session.routeId,
    routeName: session.routeName,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    track: encodePoints(session.track),
    rests: serializeRests(session.rests),
  }
  return JSON.stringify(payload)
}

/** Null rather than a throw: a hike outlives the app that recorded it. */
export function parseSession(source: string): HikeSession | null {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Partial<SerializedSession>
  if (typeof record.id !== 'string' || !Number.isFinite(record.startedAt)) return null

  return {
    id: record.id,
    routeId: typeof record.routeId === 'string' ? record.routeId : '',
    routeName: typeof record.routeName === 'string' ? record.routeName : '',
    startedAt: record.startedAt as number,
    endedAt: Number.isFinite(record.endedAt) ? (record.endedAt as number) : null,
    track: typeof record.track === 'string' ? decodePoints(record.track) : [],
    rests: typeof record.rests === 'string' ? parseRests(record.rests) : [],
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

/** Every recorded hike, newest first. Unreadable entries are skipped. */
export async function loadSessions(store: KeyValueStore): Promise<HikeSession[]> {
  const sessions: HikeSession[] = []
  for (const id of await readManifest(store)) {
    const parsed = parseSession(await store.get(sessionKey(id)))
    if (parsed !== null) sessions.push(parsed)
  }
  return sessions.sort((a, b) => b.startedAt - a.startedAt)
}

export async function saveSession(store: KeyValueStore, session: HikeSession): Promise<void> {
  await store.set(sessionKey(session.id), serializeSession(session))
  const ids = await readManifest(store)
  if (!ids.includes(session.id)) await store.set(MANIFEST_KEY, JSON.stringify([...ids, session.id]))
}

/** The manifest goes first: the store has no delete, so the value is blanked. */
export async function deleteSession(store: KeyValueStore, id: string): Promise<void> {
  const ids = await readManifest(store)
  await store.set(MANIFEST_KEY, JSON.stringify(ids.filter(existing => existing !== id)))
  await store.set(sessionKey(id), '')
}

/** A hike left open by a previous session of the app, if there is one. */
export async function resumableSession(
  store: KeyValueStore,
  routeId: string,
  withinMs = 12 * 60 * 60 * 1000,
): Promise<HikeSession | null> {
  const now = Date.now()
  for (const session of await loadSessions(store)) {
    // Only resume a hike of this route that is recent enough to still be under
    // way; an unfinished one from last month is abandoned, not in progress.
    if (session.routeId === routeId && session.endedAt === null && now - session.startedAt < withinMs) {
      return session
    }
  }
  return null
}
