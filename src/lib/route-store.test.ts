import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  deleteRoute, loadRoutes, parseRoute, routeIdFor, saveRoute, serializeRoute,
  type KeyValueStore, type RouteRecord,
} from './route-store.ts'
import { parseGpx } from './gpx.ts'
import { pathLength } from './geo.ts'

/** Mimics the host store: strings only, and a missing key reads as ''. */
function memoryStore(): KeyValueStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    get: async (key) => raw.get(key) ?? '',
    set: async (key, value) => { raw.set(key, value) },
  }
}

const sample = (): RouteRecord => {
  const doc = parseGpx(readFileSync(new URL('../../route_1.1.gpx', import.meta.url), 'utf8'))
  return { id: 'tatry', name: 'Tatry', paths: doc.paths, waypoints: doc.waypoints, stopNames: ['Murowaniec'] }
}

test('a saved route comes back with its geometry intact', async () => {
  const store = memoryStore()
  const route = sample()
  await saveRoute(store, route)

  const [back] = await loadRoutes(store)
  assert.equal(back.id, 'tatry')
  assert.deepEqual(back.stopNames, ['Murowaniec'])
  assert.equal(back.paths.length, route.paths.length)
  for (let i = 0; i < route.paths.length; i++) {
    assert.equal(back.paths[i].points.length, route.paths[i].points.length)
    const before = pathLength(route.paths[i].points)
    assert.ok(Math.abs(pathLength(back.paths[i].points) - before) < before * 0.002)
  }
})

test('saving is far smaller than the source GPX', async () => {
  const store = memoryStore()
  await saveRoute(store, sample())
  const stored = store.raw.get('route:tatry')!
  const xml = readFileSync(new URL('../../route_1.1.gpx', import.meta.url), 'utf8')
  assert.ok(Buffer.byteLength(stored) < Buffer.byteLength(xml) / 5,
    `${(Buffer.byteLength(stored) / 1024).toFixed(1)} KB vs ${(Buffer.byteLength(xml) / 1024).toFixed(1)} KB of XML`)
})

test('keys cannot be listed, so the manifest is what defines the set', async () => {
  const store = memoryStore()
  await saveRoute(store, { ...sample(), id: 'a' })
  await saveRoute(store, { ...sample(), id: 'b' })
  assert.deepEqual((await loadRoutes(store)).map(r => r.id), ['a', 'b'])

  // A value left behind with no manifest entry is invisible, by design.
  store.raw.set('routes:index', JSON.stringify(['a']))
  assert.deepEqual((await loadRoutes(store)).map(r => r.id), ['a'])
})

test('saving the same id replaces rather than duplicates', async () => {
  const store = memoryStore()
  await saveRoute(store, { ...sample(), name: 'First' })
  await saveRoute(store, { ...sample(), name: 'Second' })
  const all = await loadRoutes(store)
  assert.equal(all.length, 1)
  assert.equal(all[0].name, 'Second')
})

test('delete removes it from the manifest and blanks the value', async () => {
  const store = memoryStore()
  await saveRoute(store, { ...sample(), id: 'a' })
  await saveRoute(store, { ...sample(), id: 'b' })
  await deleteRoute(store, 'a')

  assert.deepEqual((await loadRoutes(store)).map(r => r.id), ['b'])
  assert.equal(store.raw.get('route:a'), '', 'the store has no delete, so it is blanked')
})

test('an unreadable entry is skipped, the rest of the list survives', async () => {
  const store = memoryStore()
  await saveRoute(store, { ...sample(), id: 'good' })
  await saveRoute(store, { ...sample(), id: 'broken' })
  store.raw.set('route:broken', '{"id":"broken","name":"x","paths":[')

  const all = await loadRoutes(store)
  assert.deepEqual(all.map(r => r.id), ['good'], 'one bad record cannot hide the others')
})

test('parseRoute rejects what it cannot use instead of throwing', () => {
  assert.equal(parseRoute(''), null, 'an unwritten key reads as empty string')
  assert.equal(parseRoute('not json'), null)
  assert.equal(parseRoute('{"id":"a","name":"b"}'), null, 'no paths')
  assert.equal(parseRoute('{"id":"a","name":"b","paths":[]}'), null, 'no usable paths')
  // A path of one point cannot be navigated, so it is dropped.
  assert.equal(parseRoute(serializeRoute({
    id: 'a', name: 'b', waypoints: [],
    paths: [{ name: 'p', kind: 'track', points: [{ lat: 49, lon: 20 }] }],
  })), null)
})

test('waypoints survive, including ones with no elevation', () => {
  const back = parseRoute(serializeRoute({
    id: 'a', name: 'b',
    paths: [{ name: 'p', kind: 'track', points: [{ lat: 49, lon: 20, ele: 100 }, { lat: 49.01, lon: 20, ele: 200 }] }],
    waypoints: [
      { name: 'Zawrat', point: { lat: 49.2, lon: 20.0, ele: 2159 } },
      { name: 'Spring', point: { lat: 49.21, lon: 20.01 } },
    ],
  }))!
  assert.equal(back.waypoints.length, 2)
  assert.equal(back.waypoints[0].point.ele, 2159)
  assert.equal(back.waypoints[1].point.ele, undefined)
})

test('ids are derived from the name and never collide', () => {
  assert.equal(routeIdFor('Kuźnice - Zawrat - Palenica', []), 'kuznice-zawrat-palenica')
  assert.equal(routeIdFor('Tatry', ['tatry']), 'tatry-2')
  assert.equal(routeIdFor('Tatry', ['tatry', 'tatry-2']), 'tatry-3')
  assert.equal(routeIdFor('!!!', []), 'route', 'a name with nothing usable still yields an id')
})
