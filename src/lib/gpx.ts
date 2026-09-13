/**
 * GPX -> internal paths.
 *
 * GPX 1.1 allows unbounded <trk> and <rte> elements in one file, which is what
 * makes route alternatives expressible without inventing a format: the main
 * loop and every variant ship as named siblings. What GPX does NOT encode is
 * any relationship between them — see route.ts, which recovers that from
 * geometry.
 */

import type { RoutePoint } from './geo.ts'
import { child, childrenNamed, descendants, parseXml, textOf, type XmlNode } from './xml.ts'

export interface Path {
  name: string
  /** `track` is a recorded/dense line; `route` is a sparse planned line. */
  kind: 'track' | 'route'
  points: RoutePoint[]
}

export interface Waypoint {
  name: string
  point: RoutePoint
}

export interface GpxDocument {
  paths: Path[]
  waypoints: Waypoint[]
}

function toPoint(node: XmlNode): RoutePoint | null {
  const lat = Number.parseFloat(node.attrs.lat)
  const lon = Number.parseFloat(node.attrs.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const eleText = textOf(node, 'ele')
  const ele = eleText === undefined ? undefined : Number.parseFloat(eleText)
  const point: RoutePoint = { lat, lon }
  if (ele !== undefined && Number.isFinite(ele)) point.ele = ele
  return point
}

const collect = (nodes: XmlNode[]): RoutePoint[] =>
  nodes.map(toPoint).filter((p): p is RoutePoint => p !== null)

export function parseGpx(xml: string): GpxDocument {
  const root = parseXml(xml)
  const gpx = child(root, 'gpx')
  if (!gpx) return { paths: [], waypoints: [] }

  const paths: Path[] = []

  childrenNamed(gpx, 'trk').forEach((trk, i) => {
    // Segments split a track where recording paused; for navigation they are
    // one continuous line, so they concatenate.
    const points = collect(descendants(trk, 'trkpt'))
    if (points.length > 0) {
      paths.push({ name: textOf(trk, 'name') || `Track ${i + 1}`, kind: 'track', points })
    }
  })

  childrenNamed(gpx, 'rte').forEach((rte, i) => {
    const points = collect(childrenNamed(rte, 'rtept'))
    if (points.length > 0) {
      paths.push({ name: textOf(rte, 'name') || `Route ${i + 1}`, kind: 'route', points })
    }
  })

  const waypoints: Waypoint[] = []
  childrenNamed(gpx, 'wpt').forEach((wpt, i) => {
    const point = toPoint(wpt)
    if (point) waypoints.push({ name: textOf(wpt, 'name') || `Waypoint ${i + 1}`, point })
  })

  return { paths, waypoints }
}

/* ---------- GeoJSON interchange ---------- */

export interface GeoJsonFeature {
  type: 'Feature'
  geometry: { type: 'LineString' | 'Point'; coordinates: number[][] | number[] }
  properties: Record<string, unknown>
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

/** GeoJSON order is [lon, lat, ele] — longitude first, unlike everything else here. */
const toCoords = (p: RoutePoint): number[] =>
  p.ele === undefined ? [p.lon, p.lat] : [p.lon, p.lat, p.ele]

export function toGeoJson(doc: GpxDocument, properties: Record<string, unknown> = {}): GeoJsonFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      ...doc.paths.map((path): GeoJsonFeature => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: path.points.map(toCoords) },
        properties: { name: path.name, kind: path.kind, ...properties },
      })),
      ...doc.waypoints.map((wpt): GeoJsonFeature => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: toCoords(wpt.point) },
        properties: { name: wpt.name },
      })),
    ],
  }
}

export function fromGeoJson(collection: GeoJsonFeatureCollection): GpxDocument {
  const paths: Path[] = []
  const waypoints: Waypoint[] = []
  for (const feature of collection.features) {
    const name = String(feature.properties?.name ?? '')
    if (feature.geometry.type === 'LineString') {
      const coords = feature.geometry.coordinates as number[][]
      paths.push({
        name,
        kind: feature.properties?.kind === 'route' ? 'route' : 'track',
        points: coords.map(c => (c[2] === undefined ? { lat: c[1], lon: c[0] } : { lat: c[1], lon: c[0], ele: c[2] })),
      })
    } else {
      const c = feature.geometry.coordinates as number[]
      waypoints.push({ name, point: c[2] === undefined ? { lat: c[1], lon: c[0] } : { lat: c[1], lon: c[0], ele: c[2] } })
    }
  }
  return { paths, waypoints }
}
