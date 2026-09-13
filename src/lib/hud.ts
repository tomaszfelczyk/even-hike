/**
 * What the glasses display, as data.
 *
 * Pure, and shared: the glasses push these strings into text containers, the
 * phone page renders the same values into a 576x288 box. One implementation, so
 * the mirror cannot drift from the thing it mirrors — and the wording is
 * testable without hardware.
 */

import { ascent, hikingTime, type LatLon } from './geo.ts'
import type { Following } from './follow.ts'
import { followedVariant } from './follow.ts'
import {
  foldAscii, formatDelta, nextDecision, nextStop, nextWaypoint, plannedRestBefore,
  stopNear, type RouteModel, type Segment,
} from './route.ts'
import { activeRest, restDurationMs, totalRestMs, type Rest } from './rests.ts'
import type { RoutePoint } from './geo.ts'

/** How close a sight must be before it takes over the status line. */
const SIGHT_ANNOUNCE_M = 400

export interface HudInput {
  model: RouteModel
  routeName: string
  segments: Segment[]
  /** 0 is the whole walk; 1..n are the legs between stops. */
  view: number
  following: Following | null
  /** Metres to the route when the walker is nowhere near it, else null. */
  awayM: number | null
  rests: Rest[]
  liveGps: boolean
  /** Transient message that outranks everything else on the status line. */
  notice?: string | null
  now: number
}

export interface HudProfile {
  points: RoutePoint[]
  /** Distance into the shown span, or undefined when the walker is outside it. */
  atMeters?: number
  marks: number[]
  minorMarks: number[]
}

export interface HudView {
  title: string
  stats: string
  status: string
  profile: HudProfile
}

const hhmm = (seconds: number) => {
  const total = Math.round(seconds / 60)
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`
}
const mins = (ms: number) => `${Math.round(ms / 60_000)}m`

const segmentOf = (input: HudInput): Segment | null =>
  input.view === 0 ? null : input.segments[input.view - 1] ?? null

/** Remaining distance, climb and time from a point along the main route. */
function remainingFrom(model: RouteModel, along: number) {
  const cum = model.mainCum
  let index = 0
  while (index < cum.length - 1 && cum[index] < along) index++
  const rest = model.main.points.slice(index)
  const distance = Math.max(0, model.mainLength - along)
  const climb = ascent(rest)
  const walking = hikingTime(rest)
  const pause = model.stops
    .filter(stop => stop.along > along)
    .reduce((total, stop) => total + stop.restSeconds, 0)
  return { distance, climb, walking, pause, total: walking + pause }
}

function statsText(input: HudInput): string {
  const resting = activeRest(input.rests)
  if (resting !== null) {
    // While resting, the clock on this rest is the only number that matters.
    return [
      `RESTING ${mins(restDurationMs(resting, input.now))}`,
      resting.at === undefined ? '' : foldAscii(resting.at),
      resting.ele === undefined ? '' : `${resting.ele.toFixed(0)} m`,
      '',
      `${mins(totalRestMs(input.rests, input.now))} rested today`,
    ].join('\n')
  }

  const segment = segmentOf(input)
  if (segment !== null) {
    // A segment is a fixed span: describe the leg, not progress through it.
    return [
      `${(segment.distance / 1000).toFixed(1)} km`,
      `climb ${segment.ascent.toFixed(0)} m`,
      `${hhmm(segment.time)} walking`,
      '',
      `leg ${input.view} of ${input.segments.length}`,
    ].join('\n')
  }

  if (input.awayM !== null) {
    const away = input.awayM >= 10_000
      ? `${(input.awayM / 1000).toFixed(0)} km`
      : `${(input.awayM / 1000).toFixed(1)} km`
    return ['route is', `${away} away`, '', 'preview mode'].join('\n')
  }

  if (input.following === null) return 'no fix'
  const left = remainingFrom(input.model, input.following.along)
  const pause = left.pause > 0 ? `  (+${Math.round(left.pause / 60)}m rest)` : ''
  return [
    `${(left.distance / 1000).toFixed(1)} km to go`,
    `climb ${left.climb.toFixed(0)} m`,
    `${hhmm(left.total)} left${pause}`,
    '',
    `${(input.following.along / 1000).toFixed(1)} of ${(input.model.mainLength / 1000).toFixed(1)} km`,
  ].join('\n')
}

function statusText(input: HudInput): string {
  const segment = segmentOf(input)
  if (segment !== null) {
    return `${foldAscii(segment.from)}  ->  ${foldAscii(segment.to)}` +
      `   (${(segment.fromAlong / 1000).toFixed(1)}-${(segment.toAlong / 1000).toFixed(1)} km)   scroll for more`
  }
  // A change of line, or a drift off it, outranks everything a walker could
  // otherwise be reading about.
  if (input.notice) return input.notice
  if (input.awayM !== null) return 'not on this route   (tap to preview, double-tap to exit)'
  if (input.following === null) return 'no fix'
  if (!input.following.onRoute) return `OFF ROUTE  ${input.following.offset.toFixed(0)} m`

  const variant = followedVariant(input.model, input.following)
  if (variant !== null) {
    const rejoin = variant.rejoinAlong === null
      ? ''
      : `   rejoins at ${(variant.rejoinAlong / 1000).toFixed(1)} km`
    return `on ${foldAscii(variant.path.name)} ${formatDelta(variant)}${rejoin}`
  }

  const along = input.following.along
  const decision = nextDecision(input.model, along, 1500)
  if (decision !== null) {
    const away = Math.max(0, decision.branchAlong - along)
    return `junction in ${(away / 1000).toFixed(1)} km  ->  ${foldAscii(decision.path.name)} ${formatDelta(decision)}`
  }

  // A sight is worth interrupting for only when it is about to arrive.
  const sight = nextWaypoint(input.model, along)
  if (sight !== null && sight.along - along <= SIGHT_ANNOUNCE_M) {
    const at = sight.ele === undefined ? '' : ` ${sight.ele.toFixed(0)} m`
    const off = sight.offset > 50 ? `  ${sight.offset.toFixed(0)} m off trail` : ''
    return `${foldAscii(sight.name)}${at} in ${Math.round(sight.along - along)} m${off}`
  }

  const here = stopNear(input.model, along)
  if (here !== null) {
    const taken = totalRestMs(input.rests, input.now) / 1000
    const planned = plannedRestBefore(input.model, along)
    const against = planned > 0
      ? `   rested ${Math.round(taken / 60)}m of ${Math.round(planned / 60)}m planned`
      : ''
    return `at ${foldAscii(here.name)}   long-press to rest${against}`
  }

  const stop = nextStop(input.model, along)
  if (stop !== null) {
    const away = (stop.along - along) / 1000
    const at = stop.ele === undefined ? '' : `  ${stop.ele.toFixed(0)} m`
    return `next stop ${foldAscii(stop.name)} in ${away.toFixed(1)} km${at}`
  }
  return input.liveGps ? 'on route' : 'on route   (tap to advance, double-tap to exit)'
}

function profileOf(input: HudInput): HudProfile {
  const { model } = input
  const segment = segmentOf(input)
  const points = segment === null
    ? model.main.points
    : model.main.points.slice(segment.fromIndex, segment.toIndex + 1)
  const origin = segment === null ? 0 : segment.fromAlong
  const span = segment === null ? model.mainLength : segment.toAlong - segment.fromAlong

  const along = input.following?.along
  const local = along === undefined ? undefined : along - origin
  const inside = local !== undefined && local >= 0 && local <= span

  const shift = (distance: number) => distance - origin
  const within = (distance: number) => distance > 0 && distance < span

  return {
    points,
    ...(inside ? { atMeters: local } : {}),
    marks: [...model.stops.map(s => s.along), ...model.variants.map(v => v.branchAlong)]
      .map(shift).filter(within),
    minorMarks: model.waypoints.map(w => w.along).map(shift).filter(within),
  }
}

/**
 * The message to show when the walker moves between the route and a variant.
 * Returns null when nothing changed worth saying.
 */
export function lineChangeNotice(model: RouteModel, following: Following): string | null {
  if (!following.changed) return null
  const variant = followedVariant(model, following)
  if (variant === null) return 'BACK ON MAIN ROUTE'
  return `TAKING ${foldAscii(variant.path.name).toUpperCase()}  ${formatDelta(variant)}`
}

export function hudView(input: HudInput): HudView {
  return {
    title: input.routeName,
    stats: statsText(input),
    status: statusText(input),
    profile: profileOf(input),
  }
}

/** Convenience for callers holding only a raw position. */
export type { LatLon }
