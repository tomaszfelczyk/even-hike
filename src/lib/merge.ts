/**
 * Recognising when two GPX files describe the same walk.
 *
 * Two exports that start and finish in the same places and pause at the same
 * huts are one route with a choice in it, not two routes. Importing the second
 * should add its differing legs as alternatives — which is what puts the choice
 * on the glasses at the junction, instead of burying it in a route picker the
 * walker has to stop and open.
 */

import { haversine, pathLength, type LatLon } from './geo.ts'
import type { Path } from './gpx.ts'
import { buildRoute, joinLegs } from './route.ts'
import type { RouteRecord } from './route-store.ts'

export interface RouteShape {
  start: LatLon
  finish: LatLon
  /** Where the legs meet, in order along the route. */
  stops: LatLon[]
}

/** The ends and stops of a set of paths, once chained. */
export function shapeOf(paths: readonly Path[]): RouteShape | null {
  const model = buildRoute([...paths])
  if (model === null || model.main.points.length < 2) return null
  const points = model.main.points
  return {
    start: points[0],
    finish: points[points.length - 1],
    stops: model.main.joins.map(index => points[index]),
  }
}

/**
 * Whether two shapes are the same walk.
 *
 * Either direction counts: two exports of one traverse routinely run opposite
 * ways. The tolerance is generous because a trailhead pin and a hut pin move by
 * tens of metres between exports without meaning anything.
 */
export function sameShape(a: RouteShape, b: RouteShape, toleranceM = 150): boolean {
  if (a.stops.length !== b.stops.length) return false
  const near = (p: LatLon, q: LatLon) => haversine(p, q) <= toleranceM

  const forward = near(a.start, b.start) && near(a.finish, b.finish)
    && a.stops.every((stop, i) => near(stop, b.stops[i]))
  const reversed = near(a.start, b.finish) && near(a.finish, b.start)
    && a.stops.every((stop, i) => near(stop, b.stops[b.stops.length - 1 - i]))
  return forward || reversed
}

/**
 * Whether two paths are the same stretch of trail.
 *
 * Endpoints alone are not enough — sharing both ends is exactly what makes two
 * ways round *different* — so the lengths have to agree as well.
 */
export function samePath(a: Path, b: Path, toleranceM = 30, lengthTolerance = 0.05): boolean {
  if (a.points.length === 0 || b.points.length === 0) return false
  const aStart = a.points[0]
  const aEnd = a.points[a.points.length - 1]
  const bStart = b.points[0]
  const bEnd = b.points[b.points.length - 1]

  const endsMatch =
    (haversine(aStart, bStart) <= toleranceM && haversine(aEnd, bEnd) <= toleranceM) ||
    (haversine(aStart, bEnd) <= toleranceM && haversine(aEnd, bStart) <= toleranceM)
  if (!endsMatch) return false

  const lengthA = pathLength(a.points)
  const lengthB = pathLength(b.points)
  const longer = Math.max(lengthA, lengthB)
  return longer === 0 || Math.abs(lengthA - lengthB) / longer <= lengthTolerance
}

/** An existing route the incoming paths belong to, or null. */
export function findSameRoute(
  routes: readonly RouteRecord[],
  paths: readonly Path[],
  toleranceM = 150,
): RouteRecord | null {
  const incoming = shapeOf(paths)
  if (incoming === null) return null
  for (const route of routes) {
    const existing = shapeOf(route.paths)
    if (existing !== null && sameShape(existing, incoming, toleranceM)) return route
  }
  return null
}

export interface MergeResult {
  route: RouteRecord
  /** Names given to the legs that were new. Empty means the import added nothing. */
  added: string[]
}

/**
 * Fold the incoming paths into an existing route, keeping only the legs it does
 * not already have. Shared legs are dropped rather than stored twice, since a
 * duplicate would otherwise surface as a zero-delta "alternative".
 */
export function mergeAsVariants(
  existing: RouteRecord,
  incoming: readonly Path[],
  label: string,
  toleranceM = 30,
): MergeResult {
  const paths = [...existing.paths]
  const added: string[] = []

  for (const path of incoming) {
    if (paths.some(known => samePath(known, path, toleranceM))) continue
    // One import can contribute more than one differing leg.
    const name = added.length === 0 ? label : `${label} ${added.length + 1}`
    paths.push({ ...path, name })
    added.push(name)
  }

  return { route: { ...existing, paths, updatedAt: Date.now() }, added }
}

/** Chain a record's legs into the single line it describes. */
export const mainLineOf = (record: RouteRecord): Path | undefined => joinLegs(record.paths)[0]
