/**
 * Routes compiled into the build.
 *
 * These are the fallback when nothing has been imported yet; anything the user
 * adds lives in storage as the same `RouteRecord` shape. Built-ins cannot be
 * deleted, only superseded by an import under a different id.
 */

import route11Gpx from '../route_1.1.gpx?raw'
import route1Gpx from '../route_1.gpx?raw'
import { parseGpx } from './lib/gpx.ts'
import type { RouteRecord } from './lib/route-store.ts'

const zawrat = parseGpx(route11Gpx)
const longApproach = parseGpx(route1Gpx)

export const BUILT_IN_ROUTES: RouteRecord[] = [
  {
    id: 'tatry-zawrat',
    name: 'Kuźnice - Zawrat - Palenica',
    // The second way up to Murowaniec rides along as an extra path; it shares
    // both endpoints with the first leg, so `buildRoute` reads it as an
    // alternative rather than a continuation.
    paths: [...zawrat.paths, { ...longApproach.paths[0], name: 'Long way' }],
    waypoints: zawrat.waypoints,
    stopNames: ['Murowaniec', 'PTTK Pięć Stawów'],
    restSeconds: 15 * 60,
    builtIn: true,
  },
  {
    id: 'tatry-long',
    name: 'Kuźnice - Palenica (long)',
    paths: longApproach.paths,
    waypoints: longApproach.waypoints,
    stopNames: ['Murowaniec', 'PTTK Pięć Stawów'],
    restSeconds: 15 * 60,
    builtIn: true,
  },
]
