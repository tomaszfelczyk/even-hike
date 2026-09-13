/**
 * Route model: one main line plus alternatives, with the branch/rejoin
 * relationship recovered from geometry.
 *
 * GPX gives us named polylines and nothing else — no statement that "the ridge
 * spur leaves the loop at km 4.2 and rejoins at km 7.1". That relationship is
 * what the glasses need in order to offer a choice at a junction, so we derive
 * it here, once, at load time.
 *
 * Deliberately free of SDK imports so it runs under `node --test`.
 */

import {
  ascent, cumulativeDistances, descent, haversine, hikingTime, nearestOnPath,
  pathLength, smoothElevation, type LatLon, type RoutePoint,
} from './geo.ts'
import type { Path, Waypoint } from './gpx.ts'

/** A planned pause: hut, pass, water, junction. */
export interface Stop {
  /** Metres along the main route. */
  along: number
  name: string
  /** Planned rest here, seconds. */
  restSeconds: number
  /** Elevation, when the route carried one. */
  ele?: number
}

/**
 * A place worth seeing, fixed to a position along the route.
 *
 * Deliberately not a `Stop`. A hut is somewhere you pause and it costs time; a
 * viewpoint is somewhere you look. Folding sights into stops would inflate every
 * finish estimate by rest nobody is taking.
 */
export interface RouteWaypoint {
  name: string
  /** Metres along the main route, at its closest approach. */
  along: number
  /** Metres from the route — a summit a little off the line still counts. */
  offset: number
  ele?: number
}

/** A path plus the points where separately-exported legs were chained. */
export interface JoinedPath extends Path {
  /** Indices into `points` where one leg ended and the next began. */
  joins: number[]
}

export interface Variant {
  path: Path
  /** Points of `path` forming this detour, as an inclusive index range. */
  fromIndex: number
  toIndex: number
  /**
   * True when `path` is drawn against the main route's direction, so these
   * points must be walked in reverse. Two exports of the same traverse
   * routinely run opposite ways.
   */
  reversed: boolean
  /** Metres along the main route where the walker leaves it. */
  branchAlong: number
  /** Metres along the main route where they rejoin; null for an out-and-back spur. */
  rejoinAlong: number | null
  /** Distance against staying on the main route, metres. Negative is a shortcut. */
  deltaDistance: number
  /** Ascent against the main route, metres. */
  deltaAscent: number
  /** Naismith time against the main route, seconds. */
  deltaTime: number
}

export interface RouteModel {
  main: JoinedPath
  mainCum: number[]
  mainLength: number
  mainAscent: number
  variants: Variant[]
  /** Planned pauses, ordered along the route. */
  stops: Stop[]
  /** Sights along the route, ordered. Carry no rest time. */
  waypoints: RouteWaypoint[]
  /** Paths that never came within tolerance of the main line. */
  detached: Path[]
}

export interface BuildOptions {
  /** How close a variant must pass to count as touching the main line. */
  toleranceM?: number
  /** Path to treat as the main route. Defaults to the longest. */
  mainName?: string
  /**
   * Elevation smoothing window in metres; 0 disables it. Raw exports
   * over-report climb badly enough to throw the ETA out by hours — see
   * `smoothElevation`.
   */
  smoothingM?: number
  /** Join consecutive legs before analysing. See `joinLegs`. */
  joinLegsM?: number | false
  /**
   * Rest allowed at each stop, seconds. Stops are inferred from the points
   * where separately-exported legs meet — a route split into legs is usually
   * split at the places the walker planned to pause.
   */
  restSeconds?: number
  /** Explicit stops, replacing the ones inferred from leg junctions. */
  stops?: Stop[]
  /**
   * Names for the inferred stops, in order along the route. Positions still
   * come from the data, so a re-exported GPX keeps working; only the labels
   * are supplied here.
   */
  stopNames?: string[]
  /** Points of interest, normally `parseGpx(...).waypoints`. */
  waypoints?: Waypoint[]
  /** How far off the line a waypoint may sit and still be kept, metres. */
  waypointRadiusM?: number
  /**
   * Smallest Naismith time difference that counts as a real choice, seconds.
   * Time rather than distance, because it weighs climb: a 0.7 km detour that
   * avoids 265 m of ascent saves 35 minutes, while a 0.2 km one that avoids
   * 7 m saves three. Two traces of the same trail disagree by a few minutes
   * from sampling alone, so this is what separates a choice from noise.
   */
  minDetourSeconds?: number
}

/**
 * Fraction of `a`'s interior that lies on `b`. Distinguishes a continuation
 * leg (runs somewhere else entirely) from a genuine alternative (shadows the
 * other line for much of its length).
 */
function overlapFraction(a: Path, b: Path, toleranceM: number): number {
  const samples = Math.min(20, a.points.length)
  if (samples < 3) return 0
  let near = 0
  let total = 0
  for (let k = 1; k < samples - 1; k++) {
    const index = Math.floor((k / (samples - 1)) * (a.points.length - 1))
    const projection = nearestOnPath(b.points, a.points[index])
    total++
    if (projection !== null && projection.offset <= toleranceM) near++
  }
  return total === 0 ? 0 : near / total
}

/**
 * True when both ends of `b` sit on `a`: `b` runs from one point of `a` to
 * another, which makes it an alternative way round, not a continuation.
 *
 * Endpoint-to-endpoint contact alone cannot tell the two apart. Two ways up to
 * the same hut share *both* their endpoints, so the naive test sees the far
 * ends touching and chains them into an out-and-back.
 */
function bridges(a: Path, b: Path, toleranceM: number): boolean {
  if (b.points.length === 0) return false
  const start = nearestOnPath(a.points, b.points[0])
  const end = nearestOnPath(a.points, b.points[b.points.length - 1])
  return start !== null && end !== null
    && start.offset <= toleranceM && end.offset <= toleranceM
}

interface Leg {
  points: readonly RoutePoint[]
  joins: readonly number[]
}

/** A leg walked in the given direction, with its junction indices remapped. */
function oriented(path: JoinedPath, reverse: boolean): Leg {
  if (!reverse) return { points: path.points, joins: path.joins }
  const last = path.points.length - 1
  return { points: [...path.points].reverse(), joins: path.joins.map(j => last - j).reverse() }
}

/** Append `second` to `first`, recording where they met. */
function merge(first: Leg, second: Leg): Leg {
  const a = first.points
  const b = second.points
  // The shared junction is present in both legs; keep it once.
  const skip = a.length > 0 && b.length > 0 && haversine(a[a.length - 1], b[0]) < 1 ? 1 : 0
  const offset = a.length - skip
  return {
    points: [...a, ...b.slice(skip)],
    joins: [...first.joins, a.length - 1, ...second.joins.map(j => j + offset)],
  }
}

/**
 * Join tracks that are consecutive legs of one route rather than alternatives.
 *
 * Real exports split a route at its junctions: an AllTrails custom route of one
 * Tatra traverse arrives as three same-named <trk> elements whose endpoints
 * meet exactly. Left alone, the model would pick the longest leg as the main
 * line and offer the other two as "variants" — nonsense.
 *
 * Only endpoint-to-endpoint contact joins, and only when neither path shadows
 * the other. A real variant branches from an *interior* point of the main line,
 * so it never qualifies; an alternative sharing both endpoints is caught by the
 * overlap test instead.
 */
export function joinLegs(paths: readonly Path[], toleranceM = 30): JoinedPath[] {
  const open: JoinedPath[] = paths.map(p => ({ ...p, points: [...p.points], joins: [] }))

  for (let merged = true; merged;) {
    merged = false
    search:
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const a = open[i]
        const b = open[j]
        if (a.points.length < 2 || b.points.length < 2) continue
        if (overlapFraction(a, b, toleranceM) > 0.5 || overlapFraction(b, a, toleranceM) > 0.5) continue
        if (bridges(a, b, toleranceM) || bridges(b, a, toleranceM)) continue

        const aStart = a.points[0]
        const aEnd = a.points[a.points.length - 1]
        const bStart = b.points[0]
        const bEnd = b.points[b.points.length - 1]

        let leg: Leg | null = null
        if (haversine(aEnd, bStart) <= toleranceM) leg = merge(oriented(a, false), oriented(b, false))
        else if (haversine(aEnd, bEnd) <= toleranceM) leg = merge(oriented(a, false), oriented(b, true))
        else if (haversine(aStart, bEnd) <= toleranceM) leg = merge(oriented(b, false), oriented(a, false))
        else if (haversine(aStart, bStart) <= toleranceM) leg = merge(oriented(b, true), oriented(a, false))
        if (leg === null) continue

        open[i] = { ...a, points: [...leg.points], joins: [...leg.joins] }
        open.splice(j, 1)
        merged = true
        break search
      }
    }
  }

  return open
}

/**
 * Every place `variant` departs from the main line and returns.
 *
 * One alternative can diverge more than once: two AllTrails exports of the same
 * Tatra traverse share 91% of their geometry and differ in two separate
 * stretches. Reporting only the first and last contact collapses that into a
 * useless "branches at km 0, rejoins at km 34.6" — true, but not a decision
 * anyone makes mid-hike.
 *
 * A divergence is any pair of consecutive contact points whose distance along
 * the variant differs materially from the distance along the main route between
 * them. That catches both shapes at once: a detour that wanders off and comes
 * back, and a sparsely-drawn chord that stays nominally near the line while
 * cutting off a long arc of it.
 */
function analyseVariant(
  main: Path,
  mainCum: number[],
  variant: Path,
  toleranceM: number,
  minDetourSeconds: number,
): { variants: Variant[]; touches: boolean } {
  const pts = variant.points
  const altCum = cumulativeDistances(pts)
  const contacts: { index: number; along: number; segment: number }[] = []

  for (let i = 0; i < pts.length; i++) {
    const projection = nearestOnPath(main.points, pts[i], mainCum)
    if (projection !== null && projection.offset <= toleranceM) {
      contacts.push({ index: i, along: projection.along, segment: projection.index })
    }
  }

  if (contacts.length === 0) return { variants: [], touches: false }

  // A single contact means it never comes back: walked out and back again, so
  // both the distance and the climb count twice.
  if (contacts.length === 1) {
    const at = contacts[0].index
    const armA = pts.slice(0, at + 1)
    const armB = pts.slice(at)
    const body = pathLength(armB) >= pathLength(armA) ? armB : armA
    const outAndBack = pathLength(body) * 2
    const climb = ascent(body) + descent(body)
    return {
      touches: true,
      variants: [{
        path: variant,
        fromIndex: body === armB ? at : 0,
        toIndex: body === armB ? pts.length - 1 : at,
        reversed: body !== armB,
        branchAlong: contacts[0].along,
        rejoinAlong: null,
        deltaDistance: outAndBack,
        deltaAscent: climb,
        deltaTime: hikingTime(body) + hikingTime([...body].reverse()),
      }],
    }
  }

  const variants: Variant[] = []
  for (let k = 0; k + 1 < contacts.length; k++) {
    const a = contacts[k]
    const b = contacts[k + 1]
    const altSpan = altCum[b.index] - altCum[a.index]
    const mainSpan = Math.abs(b.along - a.along)
    const deltaDistance = altSpan - mainSpan
    const body = pts.slice(a.index, b.index + 1)
    const loSegment = Math.min(a.segment, b.segment)
    const hiSegment = Math.max(a.segment, b.segment)
    const mainBody = main.points.slice(loSegment + 1, hiSegment + 2)
    const altAscent = ascent(body)
    const mainAscent = ascent(mainBody)

    const deltaTime = hikingTime(body) - hikingTime(mainBody)
    if (Math.abs(deltaTime) < minDetourSeconds) continue   // shared trail, or trace noise

    variants.push({
      path: variant,
      fromIndex: a.index,
      toIndex: b.index,
      reversed: b.along < a.along,
      branchAlong: Math.min(a.along, b.along),
      rejoinAlong: Math.max(a.along, b.along),
      deltaDistance,
      deltaAscent: altAscent - mainAscent,
      deltaTime,
    })
  }

  return { variants, touches: true }
}

export function buildRoute(paths: Path[], options: BuildOptions = {}): RouteModel | null {
  if (paths.length === 0) return null
  const toleranceM = options.toleranceM ?? 15

  // Smooth once, up front, so every ascent figure downstream — variant deltas,
  // remaining climb, Naismith — is computed from the same filtered profile.
  // Chain legs first: a route split across several <trk> elements must become
  // one line before anything is judged to be a variant of it.
  const chained: JoinedPath[] = options.joinLegsM === false
    ? paths.map(path => ({ ...path, joins: [] }))
    : joinLegs(paths, options.joinLegsM ?? 30)

  const smoothingM = options.smoothingM ?? 150
  const smoothed = chained.map(p => ({ ...p, points: smoothElevation(p.points, smoothingM) }))

  const main = options.mainName
    ? smoothed.find(p => p.name === options.mainName)
    : smoothed.reduce((a, b) => (pathLength(b.points) > pathLength(a.points) ? b : a))
  if (!main) return null

  const mainCum = cumulativeDistances(main.points)
  const variants: Variant[] = []
  const detached: Path[] = []

  const minDetourSeconds = options.minDetourSeconds ?? 300
  for (const path of smoothed) {
    if (path === main) continue
    const analysis = analyseVariant(main, mainCum, path, toleranceM, minDetourSeconds)
    if (analysis.touches) variants.push(...analysis.variants)
    else detached.push(path)
  }

  variants.sort((a, b) => a.branchAlong - b.branchAlong)

  const stops = (options.stops ?? main.joins.map((index, i) => ({
    along: mainCum[index],
    name: options.stopNames?.[i] ?? `Stop ${i + 1}`,
    restSeconds: options.restSeconds ?? 0,
    ele: main.points[index].ele,
  }))).slice().sort((a, b) => a.along - b.along)

  const waypoints: RouteWaypoint[] = []
  const waypointRadiusM = options.waypointRadiusM ?? 1000
  for (const waypoint of options.waypoints ?? []) {
    const projection = nearestOnPath(main.points, waypoint.point, mainCum)
    if (projection === null || projection.offset > waypointRadiusM) continue
    waypoints.push({
      name: waypoint.name,
      along: projection.along,
      offset: projection.offset,
      ele: waypoint.point.ele,
    })
  }
  waypoints.sort((a, b) => a.along - b.along)

  return {
    main,
    mainCum,
    stops,
    waypoints,
    mainLength: mainCum.length === 0 ? 0 : mainCum[mainCum.length - 1],
    mainAscent: ascent(main.points),
    variants,
    detached,
  }
}

/* ---------- live navigation ---------- */

export interface Progress {
  /** Metres travelled along the main route. */
  along: number
  /** Metres from the main route. */
  offset: number
  onRoute: boolean
  remainingDistance: number
  remainingAscent: number
  /** Walking seconds still to come, excluding any rest. */
  remainingTime: number
  /** Planned rest still to come, seconds. */
  remainingRest: number
  /** Walking plus rest — what a finish time should actually be based on. */
  remainingTotal: number
}

export function progressOn(model: RouteModel, position: LatLon, offRouteM = 25): Progress | null {
  const near = nearestOnPath(model.main.points, position, model.mainCum)
  if (near === null) return null
  const remainingDistance = Math.max(0, model.mainLength - near.along)
  const remainingAscent = ascent(model.main.points.slice(near.index + 1))
  const remainingTime = hikingTime(model.main.points.slice(near.index + 1))
  const remainingRest = model.stops
    .filter(stop => stop.along > near.along)
    .reduce((total, stop) => total + stop.restSeconds, 0)
  return {
    along: near.along,
    offset: near.offset,
    onRoute: near.offset <= offRouteM,
    remainingDistance,
    remainingAscent,
    remainingTime,
    remainingRest,
    remainingTotal: remainingTime + remainingRest,
  }
}

/** One leg of the walk, from start or a stop to the next stop or the finish. */
export interface Segment {
  from: string
  to: string
  fromAlong: number
  toAlong: number
  /** Inclusive index range into `model.main.points`. */
  fromIndex: number
  toIndex: number
  distance: number
  ascent: number
  /** Walking seconds, excluding rest at either end. */
  time: number
}

/** First index at or beyond `along`. */
function indexAt(cum: readonly number[], along: number): number {
  let lo = 0
  let hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] < along) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The route split at its stops. With no stops this is one segment covering the
 * whole walk, so callers never have to special-case an unsegmented route.
 */
export function segmentsOf(model: RouteModel, startName = 'Start', finishName = 'Finish'): Segment[] {
  const bounds = [0, ...model.stops.map(stop => stop.along), model.mainLength]
  const names = [startName, ...model.stops.map(stop => stop.name), finishName]
  const segments: Segment[] = []

  for (let i = 0; i + 1 < bounds.length; i++) {
    const fromIndex = indexAt(model.mainCum, bounds[i])
    const toIndex = indexAt(model.mainCum, bounds[i + 1])
    const points = model.main.points.slice(fromIndex, toIndex + 1)
    segments.push({
      from: names[i],
      to: names[i + 1],
      fromAlong: bounds[i],
      toAlong: bounds[i + 1],
      fromIndex,
      toIndex,
      distance: bounds[i + 1] - bounds[i],
      ascent: ascent(points),
      time: hikingTime(points),
    })
  }
  return segments
}

/** The stop you are standing at, if any — used to name and prompt a rest. */
export function stopNear(model: RouteModel, along: number, radiusM = 200): Stop | null {
  let best: Stop | null = null
  for (const stop of model.stops) {
    const gap = Math.abs(stop.along - along)
    if (gap <= radiusM && (best === null || gap < Math.abs(best.along - along))) best = stop
  }
  return best
}

/** Rest planned for the stops already reached, seconds. */
export function plannedRestBefore(model: RouteModel, along: number): number {
  return model.stops
    .filter(stop => stop.along <= along)
    .reduce((total, stop) => total + stop.restSeconds, 0)
}

/** The next sight ahead, or null once they are all behind. */
export function nextWaypoint(model: RouteModel, along: number): RouteWaypoint | null {
  return model.waypoints.find(waypoint => waypoint.along > along) ?? null
}

/** The next planned pause ahead, or null once they are all behind. */
export function nextStop(model: RouteModel, along: number): Stop | null {
  return model.stops.find(stop => stop.along > along) ?? null
}

/**
 * Variants still worth offering from here. Slightly-behind branches stay in the
 * list because GPS wander near a junction shouldn't make an option vanish just
 * as the walker reaches it.
 */
export function variantsAhead(model: RouteModel, along: number, lookbackM = 50): Variant[] {
  return model.variants.filter(v => v.branchAlong >= along - lookbackM)
}

/** The nearest upcoming branch, or null when none is within `withinM`. */
export function nextDecision(model: RouteModel, along: number, withinM = 400): Variant | null {
  const ahead = model.variants
    .filter(v => v.branchAlong >= along - 50 && v.branchAlong - along <= withinM)
    .sort((a, b) => a.branchAlong - b.branchAlong)
  return ahead[0] ?? null
}

/* ---------- display helpers ---------- */

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

export function formatDelta(variant: Variant): string {
  const km = variant.deltaDistance / 1000
  const distance = `${km >= 0 ? '+' : '-'}${Math.abs(km).toFixed(1)}km`
  const climb = Math.round(variant.deltaAscent)
  if (Math.abs(climb) < 10) return distance
  return `${distance} ${climb >= 0 ? '+' : '-'}${Math.abs(climb)}m`
}

/**
 * Fold a route name to characters the firmware font is known to carry, and fit
 * it to the title bar.
 *
 * Not yet confirmed to render: Polish diacritics and the em dash AllTrails puts
 * in exported names. Once the font is checked on hardware this can go.
 *
 * When it must be shortened, leading colon-separated parts are dropped before
 * the tail is cut. Route names put the region first and the actual route last —
 * "Custom route - Tatry Wysokie: Palenica Bialczanska - Kuznice" is far more
 * useful trimmed to its destination than to "...Palenica Bialczanska -".
 *
 * The 60-character default is an estimate for the 576 px title bar and has not
 * been measured against the firmware font. If titles clip or wrap on hardware,
 * this is the number to correct.
 */
export function foldAscii(text: string): string {
  return text
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')          // does not decompose under NFD
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[—–]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function displayTitle(name: string, maxChars = 60): string {
  let text = foldAscii(name)

  while (text.length > maxChars && text.includes(':')) {
    text = text.slice(text.indexOf(':') + 1).trim()
  }
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text
}

/**
 * Label for a contextual-menu entry. The firmware caps `itemName` at 32 UTF-8
 * bytes and silently rejects the whole menu past that, so the name is trimmed
 * to fit around the delta rather than the other way round — the numbers are
 * the part the walker is choosing on.
 */
export function variantLabel(variant: Variant, maxBytes = 32): string {
  const delta = formatDelta(variant)
  const budget = maxBytes - utf8Bytes(delta) - 1
  if (budget <= 0) return delta

  let name = variant.path.name.trim()
  if (utf8Bytes(name) > budget) {
    while (name.length > 0 && utf8Bytes(`${name}…`) > budget) name = name.slice(0, -1)
    name = name.length > 0 ? `${name}…` : ''
  }
  return name ? `${name} ${delta}` : delta
}
