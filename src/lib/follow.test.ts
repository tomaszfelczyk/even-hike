import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { follow, followedVariant, type Following } from './follow.ts'
import { hudView, lineChangeNotice } from './hud.ts'
import { parseGpx } from './gpx.ts'
import { buildRoute, segmentsOf, type RouteModel } from './route.ts'
import type { LatLon } from './geo.ts'

const read = (name: string) => parseGpx(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'))

/** The real Tatra route with its second way up to Murowaniec. */
const model: RouteModel = buildRoute(
  [...read('route_1.1.gpx').paths, { ...read('route_1.gpx').paths[0], name: 'Long way' }],
  { restSeconds: 900, stopNames: ['Murowaniec', 'PTTK Piec Stawow'] },
)!

const variant = model.variants[0]
const pointOnVariant = (fraction: number): LatLon => {
  const body = variant.path.points.slice(variant.fromIndex, variant.toIndex + 1)
  return body[Math.floor((body.length - 1) * fraction)]
}
const pointOnMain = (fraction: number): LatLon =>
  model.main.points[Math.floor((model.main.points.length - 1) * fraction)]

test('the route has an alternative to follow', () => {
  assert.ok(variant, 'fixture precondition')
  assert.equal(variant.path.name, 'Long way')
})

test('walking the main line follows the main line', () => {
  const at = follow(model, pointOnMain(0.5), null)!
  assert.equal(at.line.kind, 'main')
  assert.ok(at.onRoute)
  assert.equal(followedVariant(model, at), null)
})

test('walking the alternative is followed, not reported as off route', () => {
  // This is the defect the module exists for: projecting onto the main line
  // alone would call four kilometres of a legitimate choice "off route".
  const at = follow(model, pointOnVariant(0.5), null)!
  assert.equal(at.line.kind, 'variant')
  assert.ok(at.onRoute, 'on a known line, so not off route')
  assert.equal(followedVariant(model, at)?.path.name, 'Long way')
})

test('progress along a variant maps onto the main route span', () => {
  const start = follow(model, pointOnVariant(0), null)!
  const end = follow(model, pointOnVariant(1), null)!
  const low = Math.min(variant.branchAlong, variant.rejoinAlong!)
  const high = Math.max(variant.branchAlong, variant.rejoinAlong!)
  for (const at of [start, end]) {
    assert.ok(at.along >= low - 50 && at.along <= high + 50,
      `${at.along} should sit inside ${low}..${high}`)
  }
  assert.ok(Math.abs(end.along - start.along) > 1000, 'and it advances along the route')
})

test('the change is reported once, on the update it happens', () => {
  const onMain: Following = follow(model, pointOnMain(0.5), null)!
  assert.equal(onMain.changed, false, 'a first fix has nothing to differ from')

  const switched = follow(model, pointOnVariant(0.5), onMain)!
  assert.equal(switched.changed, true)
  assert.equal(lineChangeNotice(model, switched), 'TAKING LONG WAY  +4.2km +424m')

  const still = follow(model, pointOnVariant(0.55), switched)!
  assert.equal(still.changed, false, 'not announced again while still on it')
  assert.equal(lineChangeNotice(model, still), null)
})

test('returning to the main route is announced too', () => {
  const onVariant = follow(model, pointOnVariant(0.5), null)!
  const back = follow(model, pointOnMain(0.6), onVariant)!
  assert.equal(back.line.kind, 'main')
  assert.equal(lineChangeNotice(model, back), 'BACK ON MAIN ROUTE')
})

test('hysteresis stops the display flapping where two lines run together', () => {
  // At the junction both lines are underfoot. Without a margin the followed
  // line would swap on every fix as noise nudges the projection.
  const junction = model.main.points[0]
  const onVariant = follow(model, pointOnVariant(0.5), null)!
  const atJunction = follow(model, junction, onVariant, { switchMarginM: 50 })!
  assert.equal(atJunction.line.kind, 'variant', 'held, because neither is clearly closer')

  const decisive = follow(model, pointOnMain(0.5), onVariant, { switchMarginM: 50 })!
  assert.equal(decisive.line.kind, 'main', 'but a clear move does switch')
})

test('being far from everything is off route, not on a variant', () => {
  const at = follow(model, { lat: 52.23, lon: 21.01 }, null)!
  assert.equal(at.onRoute, false)
  assert.ok(at.offset > 100_000)
})

test('the status line says which alternative is being walked', () => {
  const following = follow(model, pointOnVariant(0.5), null)!
  const view = hudView({
    model, routeName: 'Tatry', segments: segmentsOf(model), view: 0,
    following, awayM: null, rests: [], liveGps: true, now: Date.now(),
  })
  assert.match(view.status, /^on Long way \+4\.2km \+424m {3}rejoins at/)
})

test('a notice outranks everything else on the status line', () => {
  const following = follow(model, pointOnMain(0.5), null)!
  const view = hudView({
    model, routeName: 'Tatry', segments: segmentsOf(model), view: 0,
    following, awayM: null, rests: [], liveGps: true, notice: 'TAKING LONG WAY', now: Date.now(),
  })
  assert.equal(view.status, 'TAKING LONG WAY')
})

test('off route gives a direction back, not just a distance', () => {
  // A hundred metres north of the line near the start.
  const onLine = model.main.points[200]
  const strayed = { lat: onLine.lat + 0.0009, lon: onLine.lon }
  const following = follow(model, strayed, null)!
  assert.equal(following.onRoute, false)

  const view = hudView({
    model, routeName: 'Tatry', segments: segmentsOf(model), view: 0,
    following, position: strayed, awayM: null, rests: [], liveGps: true, now: Date.now(),
  })
  assert.match(view.status, /^OFF ROUTE {2}\d+ m {3}back [NSEW]{1,3}$/, view.status)
})

test('without a position there is no direction to offer, and none is invented', () => {
  const onLine = model.main.points[200]
  const following = follow(model, { lat: onLine.lat + 0.0009, lon: onLine.lon }, null)!
  const view = hudView({
    model, routeName: 'Tatry', segments: segmentsOf(model), view: 0,
    following, awayM: null, rests: [], liveGps: true, now: Date.now(),
  })
  assert.match(view.status, /^OFF ROUTE {2}\d+ m$/)
})

test('the display is quiet when there is nothing to say', () => {
  const following = follow(model, model.main.points[600], null)!
  const view = hudView({
    model, routeName: 'Tatry', segments: segmentsOf(model), view: 0,
    following, awayM: null, rests: [], liveGps: true, now: Date.now(),
  })
  assert.equal(view.status, '', 'a HUD that is always talking stops being read')
  assert.equal(view.brightness, 2, 'and it dims')
})

test('the headline leads with the next stop, not the finish', () => {
  const following = follow(model, model.main.points[100], null)!
  const view = hudView({
    model, routeName: 'Tatry', segments: segmentsOf(model), view: 0,
    following, awayM: null, rests: [], liveGps: true, now: Date.now(),
  })
  const [distance, to] = view.stats.split('\n')
  assert.match(distance, /^\d+\.\d km$/)
  assert.equal(to, 'to Murowaniec', 'the thing a walker can act on')
  assert.match(view.stats, /km left/, 'the total is still there, lower down')
})

test('brightness rises for things that must be acted on', () => {
  const base = {
    model, routeName: 'Tatry', segments: segmentsOf(model), view: 0,
    awayM: null, rests: [], liveGps: true, now: Date.now(),
  }
  const quiet = hudView({ ...base, following: follow(model, model.main.points[600], null)! })
  assert.equal(quiet.brightness, 2)

  // Two kilometres north. A smaller offset is unreliable on a route that winds
  // back on itself — it can land within tolerance of a different stretch.
  const onLine = model.main.points[600]
  const strayed = follow(model, { lat: onLine.lat + 0.018, lon: onLine.lon }, null)!
  assert.equal(strayed.onRoute, false, 'test precondition')
  assert.equal(hudView({ ...base, following: strayed }).brightness, 4, 'off route')

  const noticed = hudView({ ...base, following: quietFollowing(), notice: 'TAKING LONG WAY' })
  assert.equal(noticed.brightness, 4, 'a banner')
})
function quietFollowing() { return follow(model, model.main.points[600], null)! }
