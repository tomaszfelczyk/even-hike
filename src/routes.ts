/**
 * The routes this build carries.
 *
 * Bundled rather than fetched: there is no signal on a trail. When the phone
 * page can load GPX, this list becomes the fallback and the rest comes from
 * storage — `RouteSource` is the shape either way.
 */

import route11Gpx from '../route_1.1.gpx?raw'
import route1Gpx from '../route_1.gpx?raw'

export interface RouteAlternative {
  /** GPX carrying the alternative. */
  gpx: string
  /** Which track in that file, since an export holds several legs. */
  pathIndex: number
  /** Short label; the delta is appended, and the firmware caps the pair at 32 bytes. */
  name: string
}

export interface RouteSource {
  /** Stable key. Rest logs and the selected route are stored under it. */
  id: string
  name: string
  gpx: string
  alternatives?: RouteAlternative[]
  /** Names for the stops inferred from leg junctions, in order. */
  stopNames?: string[]
  /** Rest planned at each stop, seconds. */
  restSeconds?: number
}

export const ROUTES: RouteSource[] = [
  {
    id: 'tatry-zawrat',
    name: 'Kuźnice - Zawrat - Palenica',
    gpx: route11Gpx,
    alternatives: [{ gpx: route1Gpx, pathIndex: 0, name: 'Long way' }],
    stopNames: ['Murowaniec', 'PTTK Pięć Stawów'],
    restSeconds: 15 * 60,
  },
  {
    id: 'tatry-long',
    name: 'Kuźnice - Palenica (long)',
    gpx: route1Gpx,
    stopNames: ['Murowaniec', 'PTTK Pięć Stawów'],
    restSeconds: 15 * 60,
  },
]
