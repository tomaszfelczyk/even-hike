/**
 * Rests actually taken, as opposed to the rest planned on a `Stop`.
 *
 * Planned rest is an estimate baked into the route; this is the record of what
 * happened. Keeping them apart is the point — comparing the two is what tells a
 * walker they are running late, and merging them would destroy that.
 *
 * Pure, so it is asserted under `node --test`. Persistence lives in the app.
 */

export interface Rest {
  /** Epoch milliseconds. */
  startedAt: number
  /** Epoch milliseconds, or null while the rest is still running. */
  endedAt: number | null
  /** Metres along the route where it began. */
  along: number
  lat: number
  lon: number
  ele?: number
  /** Name of the stop this happened at, when it happened at one. */
  at?: string
}

export type RestPlace = Omit<Rest, 'startedAt' | 'endedAt'>

/** The rest currently running, if any. */
export function activeRest(rests: readonly Rest[]): Rest | null {
  const last = rests[rests.length - 1]
  return last !== undefined && last.endedAt === null ? last : null
}

export function startRest(rests: readonly Rest[], place: RestPlace, now: number): Rest[] {
  // Never leave two rests open: an unterminated one is closed where it stands.
  const closed = rests.map(rest =>
    rest.endedAt === null ? { ...rest, endedAt: Math.max(rest.startedAt, now) } : rest)
  return [...closed, { ...place, startedAt: now, endedAt: null }]
}

export function endRest(rests: readonly Rest[], now: number): Rest[] {
  const active = activeRest(rests)
  if (active === null) return [...rests]
  return rests.map((rest, i) =>
    i === rests.length - 1 ? { ...rest, endedAt: Math.max(rest.startedAt, now) } : rest)
}

/** One gesture for both: start a rest, or finish the one in progress. */
export function toggleRest(rests: readonly Rest[], place: RestPlace, now: number): Rest[] {
  return activeRest(rests) === null ? startRest(rests, place, now) : endRest(rests, now)
}

/** Milliseconds rested, counting any rest still running. */
export function totalRestMs(rests: readonly Rest[], now: number): number {
  return rests.reduce((total, rest) =>
    total + Math.max(0, (rest.endedAt ?? now) - rest.startedAt), 0)
}

export function restDurationMs(rest: Rest, now: number): number {
  return Math.max(0, (rest.endedAt ?? now) - rest.startedAt)
}

/* ---------- persistence ---------- */

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const serializeRests = (rests: readonly Rest[]): string => JSON.stringify(rests)

/**
 * Parse a stored log, discarding anything malformed.
 *
 * Storage returns '' for a key that was never written, and a half-finished
 * write is possible if the app dies mid-hike — neither may throw on the next
 * launch and lose the whole log.
 */
export function parseRests(source: string): Rest[] {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const rests: Rest[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { startedAt, endedAt, along, lat, lon, ele, at } = entry as Record<string, unknown>
    if (!isFiniteNumber(startedAt) || !isFiniteNumber(along)) continue
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) continue
    if (endedAt !== null && !isFiniteNumber(endedAt)) continue
    rests.push({
      startedAt,
      endedAt: endedAt as number | null,
      along,
      lat,
      lon,
      ...(isFiniteNumber(ele) ? { ele } : {}),
      ...(typeof at === 'string' ? { at } : {}),
    })
  }
  return rests.sort((a, b) => a.startedAt - b.startedAt)
}
