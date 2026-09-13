import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodePoints, encodePoints } from './codec.ts'
import { haversine, pathLength, type RoutePoint } from './geo.ts'
import { parseGpx } from './gpx.ts'
import { joinLegs } from './route.ts'

test('round-trips to within a metre', () => {
  const points: RoutePoint[] = [
    { lat: 49.2695, lon: 19.98052, ele: 1024.35 },
    { lat: 49.26849, lon: 19.97984, ele: 1045.04 },
    { lat: 49.24327, lon: 20.00693, ele: 1512 },
  ]
  const back = decodePoints(encodePoints(points))
  assert.equal(back.length, points.length)
  for (let i = 0; i < points.length; i++) {
    assert.ok(haversine(points[i], back[i]) < 1.5, `point ${i} moved ${haversine(points[i], back[i])} m`)
    assert.ok(Math.abs(back[i].ele! - points[i].ele!) <= 0.5)
  }
})

test('a point with no elevation stays distinct from one at sea level', () => {
  const mixed: RoutePoint[] = [
    { lat: 49.2, lon: 20.0, ele: 1000 },
    { lat: 49.2001, lon: 20.0 },
    { lat: 49.2002, lon: 20.0, ele: 1002 },
  ]
  const back = decodePoints(encodePoints(mixed))
  assert.equal(back[1].ele, undefined, 'absent, not zero')
  assert.equal(back[0].ele, 1000)
  assert.equal(back[2].ele, 1002, 'and the delta chain survives the gap')
})

test('empty and malformed input do not throw', () => {
  assert.deepEqual(decodePoints(''), [])
  assert.deepEqual(encodePoints([]), '')
  // Truncated mid-stream: keep what decoded cleanly, drop the rest. Each point
  // is a delta from the last, so continuing past a bad field invents positions.
  const good = encodePoints([{ lat: 49.2, lon: 20, ele: 1000 }, { lat: 49.21, lon: 20.01, ele: 1100 }])
  const damaged = decodePoints(`${good};zz!,qq!,`)
  assert.equal(damaged.length, 2, 'the two valid points survive')
})

test('the real route compresses without losing its length', () => {
  const xml = readFileSync(new URL('../../route_1.1.gpx', import.meta.url), 'utf8')
  const route = joinLegs(parseGpx(xml).paths)[0]
  const encoded = encodePoints(route.points)
  const back = decodePoints(encoded)

  assert.equal(back.length, route.points.length)
  const before = pathLength(route.points)
  const after = pathLength(back)
  assert.ok(Math.abs(after - before) < before * 0.002,
    `length moved from ${before.toFixed(0)} to ${after.toFixed(0)} m`)

  const xmlBytes = Buffer.byteLength(xml)
  const encodedBytes = Buffer.byteLength(encoded)
  assert.ok(encodedBytes < xmlBytes / 8,
    `${(encodedBytes / 1024).toFixed(1)} KB should be under an eighth of ${(xmlBytes / 1024).toFixed(1)} KB`)
})
