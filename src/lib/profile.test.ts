import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RoutePoint } from './geo.ts'
import { renderProfile, toAscii, toRawData } from './profile.ts'

/** A hill: climbs 0 -> 100 m then back down, ~10 m between samples. */
const hill = (): RoutePoint[] =>
  Array.from({ length: 101 }, (_, i) => ({
    lat: 47,
    lon: -122 + i * 0.00013,
    ele: 100 - Math.abs(i - 50) * 2,
  }))

/** Topmost lit row in a column, or null when the column is empty. */
function topLit(bitmap: { width: number; height: number; data: Uint8Array }, x: number): number | null {
  for (let y = 0; y < bitmap.height; y++) if (bitmap.data[y * bitmap.width + x] > 0) return y
  return null
}

test('renders at the requested size', () => {
  const b = renderProfile(hill(), { width: 64, height: 32 })
  assert.equal(b.width, 64)
  assert.equal(b.height, 32)
  assert.equal(b.data.length, 64 * 32)
  assert.equal(toRawData(b).length, 64 * 32)
})

test('the summit is drawn highest, the ends lowest', () => {
  const b = renderProfile(hill(), { width: 64, height: 32 })
  const peak = topLit(b, 32)!
  const left = topLit(b, 0)!
  const right = topLit(b, 63)!
  // Row 0 is the top of the image, so a smaller row number is higher ground.
  assert.ok(peak < left, `summit (row ${peak}) should sit above the start (row ${left})`)
  assert.ok(peak < right, 'and above the finish')
  assert.ok(Math.abs(left - right) <= 2, 'a symmetric hill starts and ends level')
})

test('fill reaches the baseline; line mode does not', () => {
  const filled = renderProfile(hill(), { width: 32, height: 16, fill: true })
  const line = renderProfile(hill(), { width: 32, height: 16, fill: false })
  const bottom = (b: typeof filled, x: number) => b.data[(b.height - 1) * b.width + x] > 0
  assert.ok(bottom(filled, 16), 'filled column is solid to the bottom')
  assert.ok(!bottom(line, 16), 'line mode leaves the ground empty under the summit')
})

test('the position marker lands in the right column', () => {
  const points = hill()
  const b = renderProfile(points, { width: 100, height: 20, atMeters: 0, fill: false })
  assert.ok(topLit(b, 0) !== null, 'marker at the start is drawn in column 0')

  const mid = renderProfile(points, { width: 100, height: 20, fill: false })
  const withMarker = renderProfile(points, { width: 100, height: 20, atMeters: 1e9, fill: false })
  // Clamped to the last column rather than overflowing the buffer.
  assert.ok(topLit(withMarker, 99) !== null)
  assert.equal(mid.data.length, withMarker.data.length)
})

test('marks are ticked on the baseline only', () => {
  const b = renderProfile(hill(), { width: 100, height: 40, fill: false, marks: [0] })
  assert.equal(b.data[(b.height - 1) * b.width + 0] > 0, true, 'tick at the baseline')
  assert.equal(b.data[0 * b.width + 0] > 0, false, 'and not up the whole column')
})

test('degenerate input yields a blank bitmap rather than throwing', () => {
  for (const points of [[], [{ lat: 47, lon: -122, ele: 100 }]]) {
    const b = renderProfile(points, { width: 16, height: 8 })
    assert.equal(b.data.length, 128)
    assert.ok(b.data.every(v => v === 0))
  }
  // Every point in one spot: zero length, nothing to plot.
  const stacked = Array.from({ length: 5 }, () => ({ lat: 47, lon: -122, ele: 100 }))
  assert.ok(renderProfile(stacked, { width: 16, height: 8 }).data.every(v => v === 0))
})

test('a flat route still draws a line instead of dividing by zero', () => {
  const flat = Array.from({ length: 20 }, (_, i) => ({ lat: 47, lon: -122 + i * 0.0001, ele: 500 }))
  const b = renderProfile(flat, { width: 20, height: 10, fill: false })
  assert.ok(b.data.some(v => v > 0), 'something is drawn')
  assert.ok(b.data.every(v => Number.isFinite(v)))
})

test('ascii preview is half the pixel height and the requested width', () => {
  const b = renderProfile(hill(), { width: 64, height: 32 })
  const lines = toAscii(b, 32).split('\n')
  assert.equal(lines.length, 16, 'two pixel rows per character row')
  assert.ok(lines.every(l => l.length === 32))
})

test('sight ticks are shorter than stop ticks', () => {
  const b = renderProfile(hill(), { width: 100, height: 40, fill: false, marks: [0], minorMarks: [500] })
  const depth = (x: number) => {
    let n = 0
    for (let y = b.height - 1; y >= 0 && b.data[y * b.width + x] > 0; y--) n++
    return n
  }
  const stopX = 0
  const sightX = Math.round((500 / 1000) * (b.width - 1))
  assert.ok(depth(stopX) > depth(sightX), 'a stop reads as more than a sight')
  assert.ok(depth(sightX) > 0, 'but the sight is still drawn')
})
