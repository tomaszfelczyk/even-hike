/**
 * Elevation profile rendering.
 *
 * Produces a grayscale bitmap for an SDK image container. Pure: no SDK import,
 * so it renders and is asserted under `node --test`.
 *
 * Size ceiling comes from the firmware — `ImageContainerProperty` accepts
 * 20..288 wide and 20..144 high, so a profile can occupy at most half the
 * 576x288 canvas in each dimension.
 */

import { cumulativeDistances, type RoutePoint } from './geo.ts'

/** Unlit. The glasses draw light on dark, so this is the background. */
const OFF = 0
const DIM = 96
const MID = 160
const LIT = 255

export interface Bitmap {
  width: number
  height: number
  /** One byte per pixel, row-major from the top-left. */
  data: Uint8Array
}

export interface ProfileOptions {
  width: number
  height: number
  /**
   * Fraction of the elevation range left blank above and below. AllTrails uses
   * 0.1; on a 144 px display that spends 20% of the height on nothing, so the
   * default here is tighter.
   */
  padding?: number
  /** Fill under the curve. Far more legible than a hairline on a mono display. */
  fill?: boolean
  /** Distance along the route, metres — draws the "you are here" marker. */
  atMeters?: number
  /** Distances to tick on the baseline, e.g. stops or where a variant branches. */
  marks?: number[]
  /** Shorter ticks for things worth noting but not stopping at. */
  minorMarks?: number[]
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Elevation at an arbitrary distance, interpolated between samples. */
function elevationAt(points: readonly RoutePoint[], cum: readonly number[], distance: number): number {
  if (points.length === 0) return 0
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] < distance) lo = mid + 1
    else hi = mid
  }
  const i = Math.max(1, lo)
  const span = cum[i] - cum[i - 1]
  const t = span === 0 ? 0 : (distance - cum[i - 1]) / span
  const a = points[i - 1].ele ?? 0
  const b = points[i].ele ?? a
  return a + t * (b - a)
}

/**
 * Average elevation per pixel column. Averaging rather than sampling keeps a
 * column honest when many points fall inside it — at 288 px a 25 km route puts
 * ~85 m of trail in every column.
 */
function columnElevations(points: readonly RoutePoint[], cum: readonly number[], width: number): number[] {
  const total = cum[cum.length - 1]
  const columns = new Array<number>(width)
  let cursor = 0
  for (let x = 0; x < width; x++) {
    const from = (x / width) * total
    const to = ((x + 1) / width) * total
    while (cursor < points.length && cum[cursor] < from) cursor++
    let sum = 0
    let n = 0
    for (let j = cursor; j < points.length && cum[j] <= to; j++) {
      const ele = points[j].ele
      if (ele !== undefined) { sum += ele; n++ }
    }
    columns[x] = n > 0 ? sum / n : elevationAt(points, cum, (from + to) / 2)
  }
  return columns
}

export function renderProfile(points: readonly RoutePoint[], options: ProfileOptions): Bitmap {
  const { width, height } = options
  const data = new Uint8Array(width * height).fill(OFF)
  const bitmap: Bitmap = { width, height, data }
  if (points.length < 2 || width < 2 || height < 2) return bitmap

  const cum = cumulativeDistances(points)
  const total = cum[cum.length - 1]
  if (total <= 0) return bitmap

  const columns = columnElevations(points, cum, width)
  const lowest = Math.min(...columns)
  const highest = Math.max(...columns)
  const pad = (highest - lowest) * (options.padding ?? 0.04)
  const floor = lowest - pad
  const ceiling = highest + pad
  const range = ceiling - floor || 1

  const yOf = (ele: number) =>
    clamp(Math.round((1 - (ele - floor) / range) * (height - 1)), 0, height - 1)

  const fill = options.fill ?? true
  let previous = yOf(columns[0])

  for (let x = 0; x < width; x++) {
    const y = yOf(columns[x])
    if (fill) {
      for (let yy = y; yy < height; yy++) data[yy * width + x] = DIM
    }
    // Join to the previous column so a steep section stays a continuous ridge
    // rather than a dotted stack of disconnected pixels.
    const from = Math.min(previous, y)
    const to = Math.max(previous, y)
    for (let yy = from; yy <= to; yy++) data[yy * width + x] = LIT
    previous = y
  }

  const tick = (distance: number, depth: number) => {
    const x = clamp(Math.round((distance / total) * (width - 1)), 0, width - 1)
    for (let yy = Math.max(0, height - depth); yy < height; yy++) data[yy * width + x] = LIT
  }
  for (const mark of options.minorMarks ?? []) tick(mark, 3)
  for (const mark of options.marks ?? []) tick(mark, 6)

  if (options.atMeters !== undefined) {
    const x = clamp(Math.round((options.atMeters / total) * (width - 1)), 0, width - 1)
    for (let yy = 0; yy < height; yy++) {
      // Dashed, so the marker reads as an overlay and not as terrain.
      if (yy % 3 !== 2) data[yy * width + x] = data[yy * width + x] === LIT ? LIT : MID
    }
  }

  return bitmap
}

/** Flat byte array for `updateImageRawData`. */
export const toRawData = (bitmap: Bitmap): number[] => Array.from(bitmap.data)

const RAMP = ' .:-=+*#%@'

/**
 * Terminal preview. The glasses cannot be driven from a test, so this is how
 * a profile gets eyeballed before it ever reaches hardware.
 */
export function toAscii(bitmap: Bitmap, columns = bitmap.width): string {
  const scale = bitmap.width / columns
  const rows: string[] = []
  // Two vertical pixels per character keeps the aspect ratio roughly square.
  for (let y = 0; y < bitmap.height; y += 2) {
    let line = ''
    for (let c = 0; c < columns; c++) {
      let peak = 0
      for (let x = Math.floor(c * scale); x < Math.min(bitmap.width, Math.floor((c + 1) * scale)); x++) {
        for (let yy = y; yy < Math.min(bitmap.height, y + 2); yy++) {
          peak = Math.max(peak, bitmap.data[yy * bitmap.width + x])
        }
      }
      line += RAMP[clamp(Math.floor((peak / 255) * (RAMP.length - 1)), 0, RAMP.length - 1)]
    }
    rows.push(line)
  }
  return rows.join('\n')
}
