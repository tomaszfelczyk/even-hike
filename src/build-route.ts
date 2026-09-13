/**
 * Turn a `RouteRecord` into a model. Shared so the phone page and the glasses
 * never disagree about a route's distance, climb or stops.
 */

import { buildRoute, type RouteModel } from './lib/route.ts'
import type { RouteRecord } from './lib/route-store.ts'

export function modelFor(record: RouteRecord): RouteModel | null {
  return buildRoute(record.paths, {
    restSeconds: record.restSeconds ?? 0,
    stopNames: record.stopNames,
    waypoints: record.waypoints,
  })
}
