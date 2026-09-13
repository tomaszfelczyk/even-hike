/**
 * Compact encoding for route geometry.
 *
 * GPX is enormously redundant: the bundled 24.6 km route is 155 KB of XML for
 * 1839 points. Host storage is a string key/value store with an undocumented
 * ceiling and no chunking, so pushing raw XML through it is asking for trouble.
 *
 * Fixed-point deltas in base36 bring the same points to ~13 KB with no loss
 * that matters — coordinates quantise to 1e-5 degrees (about 1 m) and elevation
 * to 1 m, well inside GPS error and far inside the 25 m off-route tolerance.
 *
 * Thinning the track would save more and is not worth it: dropping points below
 * 10 m spacing reaches 8 KB but costs ~480 m of route length as corners are cut,
 * which propagates into every time estimate.
 */

import type { RoutePoint } from './geo.ts'

/** Degrees per stored unit. 1e-5 deg is ~1.1 m of latitude. */
const COORD_SCALE = 1e5

const BASE36 = /^-?[0-9a-z]+$/

const encodeInt = (value: number) => value.toString(36)

/**
 * `Number.parseInt` is lenient — it reads "zz!" as "zz" — so a corrupted field
 * would decode to a plausible-looking number and silently move the route.
 */
const decodeInt = (text: string) => (BASE36.test(text) ? Number.parseInt(text, 36) : Number.NaN)

export function encodePoints(points: readonly RoutePoint[]): string {
  const parts: string[] = []
  let lat = 0
  let lon = 0
  let ele = 0
  for (const point of points) {
    const a = Math.round(point.lat * COORD_SCALE)
    const b = Math.round(point.lon * COORD_SCALE)
    parts.push(
      point.ele === undefined
        // Empty third field means this point carried no elevation, which is
        // different from one at sea level.
        ? `${encodeInt(a - lat)},${encodeInt(b - lon)},`
        : `${encodeInt(a - lat)},${encodeInt(b - lon)},${encodeInt(Math.round(point.ele) - ele)}`,
    )
    lat = a
    lon = b
    if (point.ele !== undefined) ele = Math.round(point.ele)
  }
  return parts.join(';')
}

export function decodePoints(source: string): RoutePoint[] {
  if (source === '') return []
  const points: RoutePoint[] = []
  let lat = 0
  let lon = 0
  let ele = 0

  for (const part of source.split(';')) {
    const [rawLat, rawLon, rawEle] = part.split(',')
    const dLat = decodeInt(rawLat)
    const dLon = decodeInt(rawLon)
    // A malformed tail must not poison every later point, since each one is a
    // delta from the last: stop rather than emit garbage coordinates.
    if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) break
    lat += dLat
    lon += dLon

    if (rawEle === undefined || rawEle === '') {
      points.push({ lat: lat / COORD_SCALE, lon: lon / COORD_SCALE })
      continue
    }
    const dEle = decodeInt(rawEle)
    if (!Number.isFinite(dEle)) break
    ele += dEle
    points.push({ lat: lat / COORD_SCALE, lon: lon / COORD_SCALE, ele })
  }
  return points
}
