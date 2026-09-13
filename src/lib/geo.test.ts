import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ascent, bearing, compassPoint, cumulativeDistances, descent, haversine,
  hikingTime, naismith, nearestOnPath, pathLength, smoothElevation, type RoutePoint,
} from './geo.ts'

const near = (actual: number, expected: number, tol: number, what = '') =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what} expected ~${expected} (±${tol}), got ${actual}`)

test('haversine matches a known degree of latitude', () => {
  // One degree of latitude is ~111.19 km on a sphere of this radius.
  near(haversine({ lat: 47, lon: -122 }, { lat: 48, lon: -122 }), 111195, 5, 'one degree lat')
  assert.equal(haversine({ lat: 47, lon: -122 }, { lat: 47, lon: -122 }), 0)
})

test('bearing and compass point', () => {
  near(bearing({ lat: 47, lon: -122 }, { lat: 48, lon: -122 }), 0, 0.01, 'due north')
  near(bearing({ lat: 47, lon: -122 }, { lat: 47, lon: -121 }), 90, 0.5, 'due east')
  assert.equal(compassPoint(0), 'N')
  assert.equal(compassPoint(45), 'NE')
  assert.equal(compassPoint(350), 'N')
  assert.equal(compassPoint(-10), 'N')   // negatives normalise
  assert.equal(compassPoint(247.5), 'WSW')
})

test('ascent ignores sensor jitter but keeps real climb', () => {
  const jitter = [100, 101, 100, 101, 100].map(ele => ({ lat: 47, lon: -122, ele }))
  assert.equal(ascent(jitter), 0, 'a metre of noise per sample is not 400 m of climb')

  const climb = [100, 105, 110].map(ele => ({ lat: 47, lon: -122, ele }))
  assert.equal(ascent(climb), 10)

  const upDown = [100, 200, 100].map(ele => ({ lat: 47, lon: -122, ele }))
  assert.equal(ascent(upDown), 100)
  assert.equal(descent(upDown), 100)
})

test('ascent tolerates points with no elevation', () => {
  assert.equal(ascent([{ lat: 47, lon: -122 }, { lat: 47.1, lon: -122 }]), 0)
})

test('cumulative distances and path length agree', () => {
  const pts = [
    { lat: 47.0, lon: -122.0 },
    { lat: 47.0, lon: -121.99 },
    { lat: 47.005, lon: -121.985 },
  ]
  const cum = cumulativeDistances(pts)
  assert.equal(cum[0], 0)
  assert.equal(cum.length, 3)
  near(cum[2], pathLength(pts), 0.001, 'cumulative tail equals total length')
  assert.deepEqual(cumulativeDistances([]), [])
  assert.equal(pathLength([{ lat: 47, lon: -122 }]), 0)
})

test('nearestOnPath projects onto a segment, not just its vertices', () => {
  // A due-east line, queried from a point 0.001 deg north of its midpoint.
  const line = [{ lat: 47, lon: -122.0 }, { lat: 47, lon: -121.99 }]
  const near1 = nearestOnPath(line, { lat: 47.001, lon: -121.995 })!
  assert.ok(near1)
  near(near1.offset, 111.2, 1, 'perpendicular offset')
  near(near1.along, pathLength(line) / 2, 1, 'projects to the midpoint')
  assert.equal(near1.index, 0)

  // Vertex-snapping would have reported ~380 m instead of ~111 m.
  const snapped = Math.min(
    haversine({ lat: 47.001, lon: -121.995 }, line[0]),
    haversine({ lat: 47.001, lon: -121.995 }, line[1]),
  )
  assert.ok(near1.offset < snapped / 3, 'projection beats vertex snapping')
})

test('nearestOnPath handles degenerate paths', () => {
  assert.equal(nearestOnPath([], { lat: 47, lon: -122 }), null)
  const single = nearestOnPath([{ lat: 47, lon: -122 }], { lat: 47.001, lon: -122 })!
  near(single.offset, 111.2, 1, 'single-point path')
  assert.equal(single.along, 0)
})

test('naismith charges for climb as well as distance', () => {
  assert.equal(naismith(5000, 0), 3600)
  assert.equal(naismith(0, 600), 3600)
  // A 2 km shortcut that climbs 300 m is slower than 4 km of flat.
  assert.ok(naismith(2000, 300) > naismith(4000, 0))
})

/** A densely-sampled line at lat 47, ~10 m between points. */
const denseTrack = (eles: number[]): RoutePoint[] =>
  eles.map((ele, i) => ({ lat: 47, lon: -122 + i * 0.00013, ele }))

/**
 * Deterministic irregular noise. Real sensor error is not a clean oscillation
 * below the threshold — its amplitude varies and repeatedly exceeds it, which
 * is exactly the case hysteresis alone cannot catch.
 */
const noise = (i: number) => Math.sin(i * 2.4) * 4 + Math.sin(i * 0.73) * 2.5

test('smoothing removes phantom climb that hysteresis cannot', () => {
  const flat = denseTrack(Array.from({ length: 300 }, (_, i) => 1000 + noise(i)))
  // 3 km of level ground, read as most of a Munro.
  assert.ok(ascent(flat) > 500, `hysteresis alone still invents ${ascent(flat).toFixed(0)} m`)
  assert.ok(ascent(smoothElevation(flat, 60)) < 5, 'smoothing removes it')
})

test('smoothing preserves a real climb under the same noise', () => {
  const trueGain = 299 * 0.5
  const hill = denseTrack(Array.from({ length: 300 }, (_, i) => 1000 + i * 0.5 + noise(i)))
  assert.ok(ascent(hill) > 700, 'raw reading is five times the real gain')
  near(ascent(smoothElevation(hill, 60)), trueGain, 10, 'smoothed tracks the real hill')
})

test('smoothing flattens the ends slightly, and that is acceptable', () => {
  // A centred window has no data beyond the ends, so a clean ramp loses a few
  // metres there. Cheap next to the hundreds of metres of noise it removes.
  const ramp = denseTrack(Array.from({ length: 201 }, (_, i) => 1000 + i))
  near(ascent(smoothElevation(ramp, 60), 0), 200, 5, 'edge effect stays small')
})

test('smoothing leaves sparse tracks alone', () => {
  // Points ~700 m apart cannot fall inside a 60 m window.
  const sparse: RoutePoint[] = [
    { lat: 47.0, lon: -122.0, ele: 100 },
    { lat: 47.0, lon: -121.99, ele: 200 },
    { lat: 47.0, lon: -121.98, ele: 100 },
  ]
  assert.deepEqual(smoothElevation(sparse, 60), sparse)
})

test('smoothing is a no-op when disabled or when elevation is missing', () => {
  const pts = denseTrack([1000, 1010, 1000])
  assert.deepEqual(smoothElevation(pts, 0), pts)
  assert.deepEqual(smoothElevation([]), [])
  const noEle: RoutePoint[] = [{ lat: 47, lon: -122 }, { lat: 47, lon: -121.9999 }]
  assert.deepEqual(smoothElevation(noEle), noEle)
})

test('hikingTime charges for descent, unlike Naismith', () => {
  // 1 km out at a 20% descent, then back up the same slope.
  const down = denseTrack(Array.from({ length: 101 }, (_, i) => 1000 - i * 2))
  assert.equal(ascent(down, 0), 0, 'nothing is gained going down')
  assert.equal(naismith(pathLength(down), 0), naismith(pathLength(down), 0))
  // Naismith prices this identically to flat ground; Tobler does not.
  const flat = denseTrack(Array.from({ length: 101 }, () => 1000))
  assert.equal(naismith(pathLength(down), ascent(down)), naismith(pathLength(flat), ascent(flat)))
  assert.ok(hikingTime(down) > hikingTime(flat), 'steep descent is slower than flat')
})

test('hikingTime peaks on a gentle descent', () => {
  const grades = [-0.30, -0.05, 0, 0.15, 0.30]
  const times = grades.map(g =>
    hikingTime(denseTrack(Array.from({ length: 101 }, (_, i) => 1000 + i * 9.86 * g))))
  const fastest = times.indexOf(Math.min(...times))
  assert.equal(grades[fastest], -0.05, 'Tobler is quickest on a gentle downhill')
  assert.ok(times[0] > times[1], 'steep descent is slower than gentle')
  assert.ok(times[4] > times[3], 'and steeper ascent slower than shallower')
})

test('hikingTime scales with the terrain factor and survives missing elevation', () => {
  const t = denseTrack(Array.from({ length: 50 }, (_, i) => 1000 + i))
  near(hikingTime(t, 2), hikingTime(t) * 2, 0.001, 'terrain factor is linear')
  const noEle = Array.from({ length: 10 }, (_, i) => ({ lat: 47, lon: -122 + i * 0.00013 }))
  assert.ok(hikingTime(noEle) > 0 && Number.isFinite(hikingTime(noEle)))
  assert.equal(hikingTime([]), 0)
})
