import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ImageContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  StartUpPageCreateResult,
  AppLocationAccuracy,
  type AppLocation,
} from '@evenrealities/even_hub_sdk'

import { ROUTES, type RouteSource } from './routes.ts'
import { parseGpx } from './lib/gpx.ts'
import {
  buildRoute, displayTitle, foldAscii, formatDelta, nextDecision, nextStop,
  nextWaypoint, plannedRestBefore, progressOn, segmentsOf, stopNear,
  type RouteModel, type Segment,
} from './lib/route.ts'
import {
  activeRest, parseRests, restDurationMs, serializeRests, toggleRest, totalRestMs,
  type Rest,
} from './lib/rests.ts'
import { renderProfile } from './lib/profile.ts'
import { cumulativeDistances, type LatLon } from './lib/geo.ts'

const TITLE = 1
const PROFILE = 2
const STATS = 3
const STATUS = 4

const PROFILE_W = 288
const PROFILE_H = 144

/** How close a sight must be before it takes over the status line. */
const SIGHT_ANNOUNCE_M = 400

/**
 * How close a fix must be before it is treated as navigating this route.
 *
 * Beyond it, projecting onto the line is meaningless: a fix in Warsaw is 336 km
 * away and snaps to whichever end happens to be nearest, which reads on screen
 * as "0.0 km to go, climb 0 m". Report the distance to the route instead.
 */
const NAV_RADIUS_M = 250

/** Which route was last chosen. Remembered so a hike survives a restart. */
const SELECTED_KEY = 'route:selected'

/** Firmware cap on a contextual-menu label. */
const MENU_NAME_BYTES = 32

const bridge = await waitForEvenAppBridge()

/* ---------- per-route state ---------- */

// All assigned by `selectRoute`, which runs before anything reads them; the
// assertions are needed because that happens inside an awaited call.
let source!: RouteSource
let model!: RouteModel
let mainCum!: number[]
let totalM!: number
let segments!: Segment[]
let viewCount!: number
let restKey!: string
let rests!: Rest[]

let view = 0
let position!: LatLon
let liveGps = false
let awayM: number | null = null
let lastProfileColumn = -1

const currentSegment = (): Segment | null => (view === 0 ? null : segments[view - 1])

/**
 * Build everything that depends on the chosen route.
 *
 * Rest logs are keyed by route id, so switching mid-hike parks one log and
 * picks up the other rather than merging two days of walking.
 */
async function selectRoute(chosen: RouteSource): Promise<void> {
  const parsed = parseGpx(chosen.gpx)
  const alternatives = (chosen.alternatives ?? []).flatMap(alt => {
    const path = parseGpx(alt.gpx).paths[alt.pathIndex]
    return path === undefined ? [] : [{ ...path, name: alt.name }]
  })

  source = chosen
  model = buildRoute([...parsed.paths, ...alternatives], {
    restSeconds: chosen.restSeconds ?? 0,
    stopNames: chosen.stopNames,
    // Sights ride along from the GPX; none until waypoints are added to the
    // route in AllTrails and it is re-exported.
    waypoints: parsed.waypoints,
  })!

  mainCum = cumulativeDistances(model.main.points)
  totalM = model.mainLength
  segments = segmentsOf(model)
  viewCount = segments.length > 1 ? segments.length + 1 : 1

  restKey = `rests:${chosen.id}`
  rests = parseRests(await bridge.getLocalStorage(restKey))

  view = 0
  position = model.main.points[0]
  liveGps = false
  awayM = null
  lastProfileColumn = -1

  void bridge.setLocalStorage(SELECTED_KEY, chosen.id)
}

const remembered = await bridge.getLocalStorage(SELECTED_KEY)
await selectRoute(ROUTES.find(r => r.id === remembered) ?? ROUTES[0])

/* ---------- formatting ---------- */

// Straight Tobler via `hikingTime`; no terrain fudge factor.
const hhmm = (seconds: number) => {
  const t = Math.round(seconds / 60)
  return `${Math.floor(t / 60)}h${String(t % 60).padStart(2, '0')}`
}
const mins = (ms: number) => `${Math.round(ms / 60_000)}m`

/** Point at a given distance along the main route, for stepping without GPS. */
function pointAt(along: number): LatLon {
  const points = model.main.points
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (mainCum[mid] < along) lo = mid + 1
    else hi = mid
  }
  const i = Math.max(1, lo)
  const span = mainCum[i] - mainCum[i - 1]
  const t = span === 0 ? 0 : (along - mainCum[i - 1]) / span
  return {
    lat: points[i - 1].lat + t * (points[i].lat - points[i - 1].lat),
    lon: points[i - 1].lon + t * (points[i].lon - points[i - 1].lon),
  }
}

/**
 * While resting, nothing else generates an event, so the clock has to drive the
 * redraw itself. 30 s keeps the displayed minute from ever being stale, at one
 * text update per half minute — and it stops the moment the rest ends.
 */
let restTimer: ReturnType<typeof setInterval> | null = null
function syncRestTimer(): void {
  const resting = activeRest(rests) !== null
  if (resting && restTimer === null) restTimer = setInterval(() => void redraw(), 30_000)
  else if (!resting && restTimer !== null) {
    clearInterval(restTimer)
    restTimer = null
  }
}

function statsText(): string {
  const resting = activeRest(rests)
  if (resting !== null) {
    // While resting, the clock on this rest is the only number that matters.
    return [
      `RESTING ${mins(restDurationMs(resting, Date.now()))}`,
      resting.at === undefined ? '' : foldAscii(resting.at),
      resting.ele === undefined ? '' : `${resting.ele.toFixed(0)} m`,
      '',
      `${mins(totalRestMs(rests, Date.now()))} rested today`,
    ].join('\n')
  }

  const segment = currentSegment()
  if (segment !== null) {
    // A segment is a fixed span: describe the leg itself, not progress through it.
    return [
      `${(segment.distance / 1000).toFixed(1)} km`,
      `climb ${segment.ascent.toFixed(0)} m`,
      `${hhmm(segment.time)} walking`,
      '',
      `leg ${view} of ${segments.length}`,
    ].join('\n')
  }
  if (awayM !== null) {
    const away = awayM >= 10000 ? `${(awayM / 1000).toFixed(0)} km` : `${(awayM / 1000).toFixed(1)} km`
    return [`route is`, `${away} away`, '', 'preview mode'].join('\n')
  }
  const p = progressOn(model, position)
  if (p === null) return 'no fix'
  // Total, not moving time: a finish estimate that ignores planned rest is the
  // one that gets people caught out after dark.
  const rest = p.remainingRest > 0 ? `  (+${Math.round(p.remainingRest / 60)}m rest)` : ''
  return [
    `${(p.remainingDistance / 1000).toFixed(1)} km to go`,
    `climb ${p.remainingAscent.toFixed(0)} m`,
    `${hhmm(p.remainingTotal)} left${rest}`,
    '',
    `${(p.along / 1000).toFixed(1)} of ${(totalM / 1000).toFixed(1)} km`,
  ].join('\n')
}

function statusText(): string {
  const segment = currentSegment()
  if (segment !== null) {
    return `${foldAscii(segment.from)}  ->  ${foldAscii(segment.to)}` +
      `   (${(segment.fromAlong / 1000).toFixed(1)}-${(segment.toAlong / 1000).toFixed(1)} km)   scroll for more`
  }
  if (awayM !== null) return 'not on this route   (tap to preview, double-tap to exit)'
  const p = progressOn(model, position)
  if (p === null) return 'no fix'
  if (!p.onRoute) return `OFF ROUTE  ${p.offset.toFixed(0)} m`

  const decision = nextDecision(model, p.along, 1500)
  if (decision !== null) {
    const away = Math.max(0, decision.branchAlong - p.along)
    return `junction in ${(away / 1000).toFixed(1)} km  ->  ${decision.path.name} ${formatDelta(decision)}`
  }

  // A sight is worth interrupting for only when it is about to arrive.
  const sight = nextWaypoint(model, p.along)
  if (sight !== null && sight.along - p.along <= SIGHT_ANNOUNCE_M) {
    const at = sight.ele === undefined ? '' : ` ${sight.ele.toFixed(0)} m`
    const off = sight.offset > 50 ? `  ${sight.offset.toFixed(0)} m off trail` : ''
    return `${foldAscii(sight.name)}${at} in ${Math.round(sight.along - p.along)} m${off}`
  }

  // Standing at a stop having not rested: say so, since that is the moment the
  // gesture is worth knowing about.
  const here = stopNear(model, p.along)
  if (here !== null) {
    const taken = totalRestMs(rests, Date.now()) / 1000
    const planned = plannedRestBefore(model, p.along)
    const against = planned > 0
      ? `   rested ${Math.round(taken / 60)}m of ${Math.round(planned / 60)}m planned`
      : ''
    return `at ${foldAscii(here.name)}   long-press to rest${against}`
  }

  const stop = nextStop(model, p.along)
  if (stop !== null) {
    const away = (stop.along - p.along) / 1000
    const at = stop.ele === undefined ? '' : `  ${stop.ele.toFixed(0)} m`
    return `next stop ${foldAscii(stop.name)} in ${away.toFixed(1)} km${at}`
  }
  return liveGps ? 'on route' : 'on route   (tap to advance, double-tap to exit)'
}

async function pushProfile(force = false): Promise<void> {
  const p = progressOn(model, position)
  const along = p?.along ?? 0
  const segment = currentSegment()

  const points = segment === null
    ? model.main.points
    : model.main.points.slice(segment.fromIndex, segment.toIndex + 1)
  const origin = segment === null ? 0 : segment.fromAlong
  const span = segment === null ? totalM : segment.toAlong - segment.fromAlong
  // Only mark the walker when they are inside the span on show.
  const local = along - origin
  const inside = local >= 0 && local <= span

  const column = Math.round((inside ? local / span : -1) * (PROFILE_W - 1)) + view * 10000
  if (!force && column === lastProfileColumn) return
  lastProfileColumn = column

  const bitmap = renderProfile(points, {
    width: PROFILE_W,
    height: PROFILE_H,
    atMeters: inside ? local : undefined,
    marks: [...model.stops.map(s => s.along), ...model.variants.map(v => v.branchAlong)]
      .map(m => m - origin)
      .filter(m => m > 0 && m < span),
    minorMarks: model.waypoints
      .map(w => w.along - origin)
      .filter(m => m > 0 && m < span),
  })
  const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
    containerID: PROFILE,
    containerName: 'profile',
    imageData: bitmap.data,
  }))
  // Firmware renders 4-level grey, so the bitmap's tones are quantised there.
  if (result !== ImageRawDataUpdateResult.success) {
    console.error('updateImageRawData failed:', result)
  }
}

async function redraw(force = false): Promise<void> {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: TITLE, containerName: 'title', content: displayTitle(source.name),
  }))
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: STATS, containerName: 'stats', content: statsText(),
  }))
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: STATUS, containerName: 'status', content: statusText(),
  }))
  await pushProfile(force)
}

/* ---------- input ---------- */

// Subscribe before creating the page so nothing that lands during setup is lost.
bridge.onEvenHubEvent(async event => {
  // Picking a route from the contextual menu.
  const picked = event.menuItemClickEvent?.itemID
  if (picked !== undefined && picked >= 1 && picked <= ROUTES.length) {
    const chosen = ROUTES[picked - 1]
    if (chosen.id !== source.id) {
      await selectRoute(chosen)
      syncRestTimer()
      await redraw(true)
    }
    return
  }

  // CLICK_EVENT is 0 and proto3 omits zero-valued fields, so a tap arrives with
  // eventType absent. The default must be resolved inside the envelope check —
  // and because of that default, CLICK has to be tested last.
  const typeOf = (envelope?: { eventType?: OsEventTypeList }) =>
    envelope ? envelope.eventType ?? OsEventTypeList.CLICK_EVENT : null
  const types = [typeOf(event.sysEvent), typeOf(event.textEvent), typeOf(event.listEvent)]
  const saw = (type: OsEventTypeList) => types.includes(type)

  if (saw(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    await bridge.shutDownPageContainer(1)
    return
  }

  // Long press starts a rest, or ends the one running. Chosen because it is the
  // one gesture nothing else uses and it is hard to trigger by accident.
  if (saw(OsEventTypeList.LONG_PRESS_EVENT)) {
    const p = progressOn(model, position)
    const here = p === null ? null : stopNear(model, p.along)
    rests = toggleRest(rests, {
      along: p?.along ?? 0,
      lat: position.lat,
      lon: position.lon,
      ...(here?.ele === undefined ? {} : { ele: here.ele }),
      ...(here === null ? {} : { at: here.name }),
    }, Date.now())
    // Written on every change: a hike outlasts the app, and an interrupted
    // session must not lose the log.
    void bridge.setLocalStorage(restKey, serializeRests(rests))
    syncRestTimer()
    await redraw(true)
    return
  }

  // Scroll moves between the whole walk and each leg between stops.
  if (viewCount > 1 && (saw(OsEventTypeList.SCROLL_TOP_EVENT) || saw(OsEventTypeList.SCROLL_BOTTOM_EVENT))) {
    const step = saw(OsEventTypeList.SCROLL_TOP_EVENT) ? -1 : 1
    view = (view + step + viewCount) % viewCount
    await redraw(true)
    return
  }

  if (saw(OsEventTypeList.CLICK_EVENT)) {
    if (liveGps) return   // a real fix is driving the display; stepping would fight it
    // Without a fix, walk the route by tapping so the display can be exercised
    // in the simulator and on the glasses indoors.
    const p = progressOn(model, position)
    position = pointAt(((p?.along ?? 0) + totalM / 24) % totalM)
    await redraw()
  }
})

/* ---------- page ---------- */

/**
 * Fold and trim to the firmware's label budget, preferring a word boundary.
 * The menu silently rejects an over-long name, so this must not be optimistic.
 */
function menuLabel(name: string): string {
  const encoder = new TextEncoder()
  const folded = foldAscii(name)
  if (encoder.encode(folded).length <= MENU_NAME_BYTES) return folded

  let out = folded
  while (out.length > 0 && encoder.encode(out).length > MENU_NAME_BYTES) out = out.slice(0, -1)
  const lastSpace = out.lastIndexOf(' ')
  // Only step back to a word boundary if it does not cost most of the label.
  if (lastSpace > MENU_NAME_BYTES / 2) out = out.slice(0, lastSpace)
  return out.trimEnd()
}

const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 4,
  textObject: [
    new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 26,
      containerID: TITLE, containerName: 'title', zOrderIndex: 1,
      content: displayTitle(source.name), isEventCapture: 0,
    }),
    new TextContainerProperty({
      xPosition: 300, yPosition: 32, width: 276, height: 144,
      containerID: STATS, containerName: 'stats', zOrderIndex: 3,
      content: statsText(), isEventCapture: 0,
    }),
    new TextContainerProperty({
      xPosition: 0, yPosition: 182, width: 576, height: 100, paddingLength: 2,
      containerID: STATUS, containerName: 'status', zOrderIndex: 4,
      content: statusText(), isEventCapture: 1,
    }),
  ],
  imageObject: [
    new ImageContainerProperty({
      xPosition: 0, yPosition: 32, width: PROFILE_W, height: PROFILE_H,
      containerID: PROFILE, containerName: 'profile', zOrderIndex: 2,
    }),
  ],
  // The route picker. Firmware allows at most 10 items, each id non-zero and
  // unique; the layout never changes between routes, so this is set once and
  // switching is only a text and image update.
  menuObject: new MenuContainerProperty({
    menuItems: ROUTES.slice(0, 10).map((route, i) => new MenuItemProperty({
      itemName: menuLabel(route.name),
      itemID: i + 1,
    })),
  }),
}))

syncRestTimer()

if (result !== StartUpPageCreateResult.success) {
  console.error('createStartUpPageContainer failed:', result)
} else {
  await pushProfile(true)
}

// A real fix takes over only once it is actually near the route.
bridge.onAppLocationChanged((location: AppLocation) => {
  const fix: LatLon = { lat: location.latitude, lon: location.longitude }
  const p = progressOn(model, fix)
  if (p === null) return

  if (p.offset > NAV_RADIUS_M) {
    // Far from the line: say so, and leave tap stepping working rather than
    // silently reporting progress along a route nobody is walking.
    awayM = p.offset
    liveGps = false
  } else {
    awayM = null
    liveGps = true
    position = fix
  }
  void redraw()
})
void bridge.startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, distanceFilter: 10 })
