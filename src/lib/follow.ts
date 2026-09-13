/**
 * Working out which line the walker is actually on.
 *
 * `progressOn` projects onto the main route alone, which is wrong the moment an
 * alternative is taken: walking the long way to the hut would read as four
 * kilometres of being off route. Following considers the main line *and* every
 * variant, and reports which one is underfoot.
 */

import { cumulativeDistances, nearestOnPath, type LatLon } from './geo.ts'
import type { RouteModel, Variant } from './route.ts'

export type FollowedLine = { kind: 'main' } | { kind: 'variant'; index: number }

export interface Following {
  line: FollowedLine
  /** Metres along the **main** route; a variant maps onto its branch..rejoin span. */
  along: number
  /** Metres from whichever line is being followed. */
  offset: number
  onRoute: boolean
  /** True only on the update where the followed line changed. */
  changed: boolean
}

export interface FollowOptions {
  /** Beyond this from every known line, the walker is off route. */
  offRouteM?: number
  /**
   * How much closer another line must be before the walker is judged to have
   * moved onto it. Without this the display flaps between route and variant at
   * every junction, where both are literally underfoot.
   */
  switchMarginM?: number
}

interface Candidate {
  line: FollowedLine
  along: number
  offset: number
}

const sameLine = (a: FollowedLine, b: FollowedLine) =>
  a.kind === b.kind && (a.kind !== 'variant' || b.kind !== 'variant' || a.index === b.index)

/** The stretch of a variant's path that actually leaves the main route. */
function bodyOf(variant: Variant) {
  return variant.path.points.slice(variant.fromIndex, variant.toIndex + 1)
}

function variantCandidate(variant: Variant, index: number, position: LatLon): Candidate | null {
  const body = bodyOf(variant)
  if (body.length < 2) return null
  const cum = cumulativeDistances(body)
  const near = nearestOnPath(body, position, cum)
  if (near === null) return null

  const total = cum[cum.length - 1]
  const progress = total === 0 ? 0 : near.along / total
  const from = variant.branchAlong
  const to = variant.rejoinAlong ?? variant.branchAlong
  // A variant drawn against the route's direction is walked from its rejoin
  // back towards its branch, so the mapping runs the other way.
  const along = variant.reversed
    ? to - progress * (to - from)
    : from + progress * (to - from)

  return { line: { kind: 'variant', index }, along, offset: near.offset }
}

/**
 * Locate a fix against the route and its alternatives.
 *
 * Pass the previous result back in; it supplies the hysteresis that keeps the
 * display from oscillating where two lines run together.
 */
export function follow(
  model: RouteModel,
  position: LatLon,
  previous: Following | null,
  options: FollowOptions = {},
): Following | null {
  const offRouteM = options.offRouteM ?? 25
  const switchMarginM = options.switchMarginM ?? 20

  const candidates: Candidate[] = []
  const onMain = nearestOnPath(model.main.points, position, model.mainCum)
  if (onMain !== null) {
    candidates.push({ line: { kind: 'main' }, along: onMain.along, offset: onMain.offset })
  }
  model.variants.forEach((variant, index) => {
    const candidate = variantCandidate(variant, index, position)
    if (candidate !== null) candidates.push(candidate)
  })
  if (candidates.length === 0) return null

  let best = candidates.reduce((a, b) => (b.offset < a.offset ? b : a))

  if (previous !== null) {
    const held = candidates.find(candidate => sameLine(candidate.line, previous.line))
    // Stay put unless the newcomer is clearly better, not merely nearer.
    if (held !== undefined && best.offset > held.offset - switchMarginM) best = held
  }

  return {
    line: best.line,
    along: best.along,
    offset: best.offset,
    onRoute: best.offset <= offRouteM,
    changed: previous !== null && !sameLine(best.line, previous.line),
  }
}

/** The variant being walked, or null when it is the main route. */
export function followedVariant(model: RouteModel, following: Following): Variant | null {
  return following.line.kind === 'variant' ? model.variants[following.line.index] ?? null : null
}
