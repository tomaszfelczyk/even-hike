import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { findSameRoute, mergeAsVariants, samePath, sameShape, shapeOf } from './merge.ts'
import { parseGpx } from './gpx.ts'
import { buildRoute } from './route.ts'
import type { RouteRecord } from './route-store.ts'

const read = (name: string) => parseGpx(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'))
const record = (id: string, name: string, gpx: string): RouteRecord => {
  const doc = read(gpx)
  return { id, name, paths: doc.paths, waypoints: doc.waypoints }
}

test('two exports of the same traverse are recognised as one walk', () => {
  // route_1 and route_1.1 share Kuznice, Palenica, Murowaniec and Piec Stawow,
  // and differ only in how they get up to the first hut.
  const a = shapeOf(read('route_1.gpx').paths)!
  const b = shapeOf(read('route_1.1.gpx').paths)!
  assert.equal(a.stops.length, 2)
  assert.equal(b.stops.length, 2)
  assert.ok(sameShape(a, b), 'same ends and same stops')
})

test('a different walk is not mistaken for the same one', () => {
  const tatry = shapeOf(read('route_1.1.gpx').paths)!
  const elsewhere = shapeOf(read('test.gpx').paths)!
  assert.equal(sameShape(tatry, elsewhere), false, 'different place, different stop count')
})

test('shape matching ignores which way the route was drawn', () => {
  const forward = shapeOf(read('route_1.1.gpx').paths)!
  const reversed = {
    start: forward.finish,
    finish: forward.start,
    stops: [...forward.stops].reverse(),
  }
  assert.ok(sameShape(forward, reversed), 'two exports of one traverse often run opposite ways')
})

test('importing the other export merges as an alternative, not a new route', () => {
  const existing = record('tatry', 'Tatry', 'route_1.1.gpx')
  const incoming = read('route_1.gpx').paths

  assert.equal(findSameRoute([existing], incoming)?.id, 'tatry')

  const { route, added } = mergeAsVariants(existing, incoming, 'Long way')
  assert.deepEqual(added, ['Long way'], 'only the leg that differs is taken')
  assert.equal(route.paths.length, existing.paths.length + 1,
    'the two shared legs are not stored twice')

  // And the merged record is what puts the choice on the glasses.
  const model = buildRoute(route.paths, { stopNames: ['Murowaniec', 'Piec Stawow'] })!
  assert.equal(model.stops.length, 2, 'still two stops, not four')
  assert.ok(model.variants.length >= 1, 'the differing leg reads as a variant')
  const alternative = model.variants.find(v => v.path.name === 'Long way')!
  assert.ok(alternative, 'named so it can be labelled on the menu')
  assert.ok(alternative.deltaDistance > 3000, `the long way is ~4 km longer, got ${alternative.deltaDistance}`)
})

test('re-importing the identical file adds nothing', () => {
  const existing = record('tatry', 'Tatry', 'route_1.1.gpx')
  const { route, added } = mergeAsVariants(existing, read('route_1.1.gpx').paths, 'Again')
  assert.deepEqual(added, [], 'every leg is already known')
  assert.equal(route.paths.length, existing.paths.length)
})

test('samePath separates a shared leg from two ways round', () => {
  const short = read('route_1.1.gpx').paths
  const long = read('route_1.gpx').paths
  // Legs 2 and 3 are identical between the exports.
  assert.ok(samePath(short[1], long[1]), 'same leg')
  assert.ok(samePath(short[2], long[2]), 'same leg')
  // Leg 1 shares both endpoints but is half the length — the whole point.
  assert.equal(samePath(short[0], long[0]), false, 'two ways up to the hut')
})

test('an unrelated import is left as its own route', () => {
  const existing = record('tatry', 'Tatry', 'route_1.1.gpx')
  assert.equal(findSameRoute([existing], read('test.gpx').paths), null)
})

test('shapeOf copes with input it cannot build a route from', () => {
  assert.equal(shapeOf([]), null)
  assert.equal(shapeOf([{ name: 'x', kind: 'track', points: [{ lat: 49, lon: 20 }] }]), null)
})
