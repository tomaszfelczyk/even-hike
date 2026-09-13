/**
 * Turn a `RouteSource` into a model. Shared so the phone page and the glasses
 * never disagree about a route's distance, climb or stops.
 */

import { parseGpx } from './lib/gpx.ts'
import { buildRoute, type RouteModel } from './lib/route.ts'
import type { RouteSource } from './routes.ts'

export function modelFor(source: RouteSource): RouteModel {
  const parsed = parseGpx(source.gpx)
  const alternatives = (source.alternatives ?? []).flatMap(alt => {
    const path = parseGpx(alt.gpx).paths[alt.pathIndex]
    return path === undefined ? [] : [{ ...path, name: alt.name }]
  })
  return buildRoute([...parsed.paths, ...alternatives], {
    restSeconds: source.restSeconds ?? 0,
    stopNames: source.stopNames,
    // Sights ride along from the GPX; none until waypoints are added to the
    // route in AllTrails and it is re-exported.
    waypoints: parsed.waypoints,
  })!
}
