/**
 * Spherical geometry for route work. Everything is metres and degrees;
 * nothing here touches the SDK, so it runs in Node tests unchanged.
 */

/** WGS-84 mean radius. */
const EARTH_RADIUS_M = 6371008.8
const M_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_M

export interface LatLon {
  lat: number
  lon: number
}

export interface RoutePoint extends LatLon {
  /** Metres above sea level, when the source supplied it. */
  ele?: number
}

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(toRad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from `from` to `to`, degrees clockwise from north. */
export function bearing(from: LatLon, to: LatLon): number {
  const lat1 = toRad(from.lat)
  const lat2 = toRad(to.lat)
  const dLon = toRad(to.lon - from.lon)
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

/** 16-point compass label, for the glasses HUD where degrees read poorly. */
export function compassPoint(bearingDeg: number): string {
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16
  return COMPASS[i]!
}

/** Prefix sums of segment lengths; `[0]` is always 0. Empty in, empty out. */
export function cumulativeDistances(points: readonly RoutePoint[]): number[] {
  if (points.length === 0) return []
  const cum = new Array<number>(points.length)
  cum[0] = 0
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1]! + haversine(points[i - 1]!, points[i]!)
  }
  return cum
}

export function pathLength(points: readonly RoutePoint[]): number {
  if (points.length < 2) return 0
  let total = 0
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1]!, points[i]!)
  return total
}

/**
 * Total positive elevation gain.
 *
 * Barometric and GPS elevation both jitter by a metre or two per sample, and
 * naively summing every rise inflates a flat walk into hundreds of metres of
 * "climb". The threshold is hysteresis: the reference only ratchets up once a
 * rise clears it, but follows every descent down immediately.
 */
export function ascent(points: readonly RoutePoint[], thresholdM = 3): number {
  let total = 0
  let ref: number | undefined
  for (const p of points) {
    if (p.ele === undefined) continue
    if (ref === undefined) { ref = p.ele; continue }
    const delta = p.ele - ref
    if (delta >= thresholdM) { total += delta; ref = p.ele }
    else if (delta < 0) { ref = p.ele }
  }
  return total
}

/**
 * Moving average over elevation within a distance window.
 *
 * Hysteresis alone is not enough on a densely-sampled real track. An AllTrails
 * export of a 35 km Tatra traverse samples every ~8 m, and its median
 * elevation step is 1.5 m — an 18% grade at every single sample, which no
 * trail actually sustains. Summing that yields 3658 m of "climb" against a
 * smoothed ~2500 m. Naismith charges an hour per 600 m, so the difference is
 * two hours of ETA.
 *
 * The window is measured in metres, not points, because sampling density
 * varies along a track (that file: median 8 m, max 155 m) and a point-count
 * window would smooth unevenly.
 *
 * The 150 m default was tuned against that export. Counting only climbs with
 * real prominence — the way a walker tallies "up to the pass, down, up to the
 * next" — puts its true ascent at 2500 m over four climbs, and at >=20 m
 * prominence 2712 m. A 150 m window reads 2658 m, inside that band; raw reads
 * 3658 m and a 60 m window still reads 2973 m. Re-check it against another
 * export before trusting it on very differently sampled data.
 */
export function smoothElevation(points: readonly RoutePoint[], windowM = 150): RoutePoint[] {
  if (points.length === 0 || windowM <= 0) return [...points]
  const cum = cumulativeDistances(points)
  const half = windowM / 2
  const out: RoutePoint[] = new Array(points.length)
  let lo = 0
  let hi = 0
  let sum = 0
  let count = 0

  // cum is non-decreasing, so both bounds only ever advance: O(n) overall.
  for (let i = 0; i < points.length; i++) {
    while (hi < points.length && cum[hi] <= cum[i] + half) {
      const ele = points[hi].ele
      if (ele !== undefined) { sum += ele; count++ }
      hi++
    }
    while (cum[lo] < cum[i] - half) {
      const ele = points[lo].ele
      if (ele !== undefined) { sum -= ele; count-- }
      lo++
    }
    out[i] = points[i].ele === undefined || count === 0
      ? points[i]
      : { ...points[i], ele: sum / count }
  }
  return out
}

/** Positive elevation loss, as a magnitude. */
export function descent(points: readonly RoutePoint[], thresholdM = 3): number {
  return ascent([...points].reverse(), thresholdM)
}

export interface PathPosition {
  /** Index of the segment's first vertex. */
  index: number
  /** Perpendicular distance from the query point to the path, metres. */
  offset: number
  /** Distance travelled along the path to reach the projection, metres. */
  along: number
  /** The projected point on the path. */
  point: LatLon
}

/**
 * Nearest point on a polyline, projected onto segments rather than snapped to
 * vertices. Vertex-snapping would report a hiker as far off-route simply
 * because the track is coarsely sampled through a long straight section.
 */
export function nearestOnPath(
  points: readonly RoutePoint[],
  target: LatLon,
  cum?: readonly number[],
): PathPosition | null {
  if (points.length === 0) return null
  const distances = cum ?? cumulativeDistances(points)
  if (points.length === 1) {
    return { index: 0, offset: haversine(points[0]!, target), along: 0, point: points[0]! }
  }

  // Local planar frame centred on the query point. Distortion is negligible
  // over the few hundred metres that can plausibly be the nearest segment.
  const cosLat = Math.cos(toRad(target.lat))
  const x = (p: LatLon) => (p.lon - target.lon) * M_PER_DEG * cosLat
  const y = (p: LatLon) => (p.lat - target.lat) * M_PER_DEG

  let best: PathPosition | null = null
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const ax = x(a), ay = y(a)
    const bx = x(b), by = y(b)
    const dx = bx - ax, dy = by - ay
    const lenSq = dx * dx + dy * dy
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq))
    const px = ax + t * dx
    const py = ay + t * dy
    const offset = Math.hypot(px, py)
    if (best === null || offset < best.offset) {
      best = {
        index: i - 1,
        offset,
        along: distances[i - 1]! + t * (distances[i]! - distances[i - 1]!),
        point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) },
      }
    }
  }
  return best
}

/**
 * Tobler's hiking function: speed as a continuous function of gradient.
 *
 * Naismith reduces a route to two numbers — distance and total ascent — and
 * charges nothing whatsoever for descent. On this Tatra route that hides 1h24
 * of steep downhill, which is most of why it reads 7h46 against AllTrails'
 * 10.5-11.5 h.
 *
 * Tobler integrates per segment instead:
 *
 *     speed = 6 * exp(-3.5 * |gradient + 0.05|) km/h
 *
 * peaking at 6 km/h on a gentle 2.9-degree descent and falling away in both
 * directions, so steep descent is correctly slower than flat ground.
 *
 * Feed it smoothed elevation. At ~8 m sampling, raw jitter makes every segment
 * look near-vertical and the speed term collapses — on this route raw input
 * costs an extra 1h13 of pure noise.
 *
 * `terrainFactor` scales for ground the original fit does not cover: scrambling,
 * chains, scree. 1 is the unmodified function.
 */
export function hikingTime(points: readonly RoutePoint[], terrainFactor = 1): number {
  let seconds = 0
  for (let i = 1; i < points.length; i++) {
    const run = haversine(points[i - 1], points[i])
    if (run === 0) continue
    const rise = (points[i].ele ?? 0) - (points[i - 1].ele ?? 0)
    const kmh = 6 * Math.exp(-3.5 * Math.abs(rise / run + 0.05))
    seconds += run / ((kmh * 1000) / 3600)
  }
  return seconds * terrainFactor
}

/**
 * Naismith's rule: one hour per 5 km, plus one hour per 600 m of ascent.
 * Returns seconds. Distance alone is a poor guide on a hill — a 2 km
 * "shortcut" that climbs 300 m is not a shortcut.
 */
export function naismith(distanceM: number, ascentM: number): number {
  return (distanceM / 5000) * 3600 + (Math.max(0, ascentM) / 600) * 3600
}
