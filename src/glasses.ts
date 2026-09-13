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

import type { RouteRecord } from './lib/route-store.ts'
import { store } from './storage.ts'
import { provideBridge } from './storage.ts'
import { modelFor } from './build-route.ts'
import { displayTitle, foldAscii, segmentsOf, stopNear, type RouteModel, type Segment } from './lib/route.ts'
import { activeRest, parseRests, serializeRests, toggleRest, type Rest } from './lib/rests.ts'
import {
  endSession, recordFix, resumableSession, saveSession, startSession, type HikeSession,
} from './lib/history.ts'
import { renderProfile } from './lib/profile.ts'
import { follow, type Following } from './lib/follow.ts'
import { hudView, lineChangeNotice, type HudView } from './lib/hud.ts'
import { cumulativeDistances, type LatLon } from './lib/geo.ts'

const TITLE = 1
const PROFILE = 2
const STATS = 3
const STATUS = 4

const PROFILE_W = 288
const PROFILE_H = 144

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

import { getState, setState, subscribe, type GlassesStatus } from './store.ts'

/**
 * True when the page is running inside the Even App WebView.
 *
 * `waitForEvenAppBridge()` cannot be used for this: it resolves optimistically
 * in an ordinary browser and every later call then warns "Flutter handler not
 * available" while `createStartUpPageContainer` quietly returns `invalid`. The
 * host handler is the only honest signal.
 */
export function hasEvenAppHost(): boolean {
  const host = (globalThis as { flutter_inappwebview?: { callHandler?: unknown } }).flutter_inappwebview
  return typeof host?.callHandler === 'function'
}

/**
 * Attach to the glasses, reporting what actually happened.
 *
 * Called without blocking the React page, which is what lets the phone UI be
 * developed in an ordinary browser tab.
 */
export async function startGlasses(): Promise<GlassesStatus> {
if (!hasEvenAppHost()) return 'unavailable'

const bridge = await waitForEvenAppBridge()
provideBridge(bridge)

/* ---------- per-route state ---------- */

// All assigned by `selectRoute`, which runs before anything reads them; the
// assertions are needed because that happens inside an awaited call.
let source!: RouteRecord
let model!: RouteModel
let mainCum!: number[]
let totalM!: number
let segments!: Segment[]
let viewCount!: number
let restKey!: string
let rests!: Rest[]

/** How long a line-change banner holds the status line. */
const NOTICE_MS = 12_000

/**
 * How often the hike in progress is written out.
 *
 * Fixes arrive every few metres for hours; writing on each one would push a
 * growing blob across the bridge thousands of times. Thirty seconds bounds the
 * loss if the app dies to the last half minute of walking.
 */
const SESSION_SAVE_MS = 30_000

let view = 0
let position!: LatLon
let following: Following | null = null
let notice: string | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null
let liveGps = false
let awayM: number | null = null
let lastProfileColumn = -1
let session: HikeSession | null = null
let sessionSavedAt = 0

/**
 * Build everything that depends on the chosen route.
 *
 * Rest logs are keyed by route id, so switching mid-hike parks one log and
 * picks up the other rather than merging two days of walking.
 */
async function selectRoute(chosen: RouteRecord): Promise<void> {
  const built = modelFor(chosen)
  if (built === null) throw new Error(`route ${chosen.id} has no usable paths`)
  source = chosen
  model = built

  mainCum = cumulativeDistances(model.main.points)
  totalM = model.mainLength
  segments = segmentsOf(model)
  viewCount = segments.length > 1 ? segments.length + 1 : 1

  restKey = `rests:${chosen.id}`
  rests = parseRests(await store.get(restKey))
  // Pick up a hike of this route that is still under way, so closing the app
  // mid-walk does not split one afternoon into two records.
  session = await resumableSession(store, chosen.id)
  sessionSavedAt = 0

  if (session !== null) {
    // The hike belongs to the route it was walked on, so switching ends it.
    await saveSession(store, endSession(session, Date.now()))
    session = null
  }

  view = 0
  position = model.main.points[0]
  following = null
  notice = null
  liveGps = false
  awayM = null
  lastProfileColumn = -1
  relocate(position)

  void bridge.setLocalStorage(SELECTED_KEY, chosen.id)
  setState({ routeId: chosen.id, rests })
}

const routes = () => getState().routes
const remembered = await bridge.getLocalStorage(SELECTED_KEY)
const initial = routes().find(r => r.id === remembered)
  ?? routes().find(r => r.id === getState().routeId)
  ?? routes()[0]
if (initial === undefined) return 'failed'
await selectRoute(initial)

/* ---------- rendering ---------- */

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

/** Re-locate against the route and its alternatives, and announce a change. */
function relocate(position: LatLon): void {
  const next = follow(model, position, following)
  following = next
  if (next !== null) {
    const message = lineChangeNotice(model, next)
    if (message !== null) {
      notice = message
      if (noticeTimer !== null) clearTimeout(noticeTimer)
      // Long enough to read while walking, short enough not to bury the
      // navigation it is sitting on top of.
      noticeTimer = setTimeout(() => {
        notice = null
        publish()
        void redraw(true)
      }, NOTICE_MS)
    }
  }
}

function currentHud(): HudView {
  return hudView({
    model,
    routeName: displayTitle(source.name),
    segments,
    view,
    following,
    awayM,
    rests,
    liveGps,
    notice,
    now: Date.now(),
  })
}

/** Mirror the live state so the phone page renders the same HUD. */
function publish(): void {
  setState({ view, following, awayM, liveGps, notice, rests })
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

async function pushProfile(hud: HudView, force = false): Promise<void> {
  const column = Math.round(((hud.profile.atMeters ?? -1) / 1000) * 100) + view * 10_000
  if (!force && column === lastProfileColumn) return
  lastProfileColumn = column

  const bitmap = renderProfile(hud.profile.points, {
    width: PROFILE_W,
    height: PROFILE_H,
    ...(hud.profile.atMeters === undefined ? {} : { atMeters: hud.profile.atMeters }),
    marks: hud.profile.marks,
    minorMarks: hud.profile.minorMarks,
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
  const hud = currentHud()
  publish()
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: TITLE, containerName: 'title', content: hud.title,
  }))
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: STATS, containerName: 'stats', content: hud.stats,
  }))
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: STATUS, containerName: 'status', content: hud.status,
  }))
  await pushProfile(hud, force)
}

/* ---------- input ---------- */

// Subscribe before creating the page so nothing that lands during setup is lost.
bridge.onEvenHubEvent(async event => {
  // Picking a route from the contextual menu.
  const picked = event.menuItemClickEvent?.itemID
  if (picked !== undefined && picked >= 1 && picked <= routes().length) {
    const chosen = routes()[picked - 1]
    if (chosen !== undefined && chosen.id !== source.id) {
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
    if (session !== null) {
      await saveSession(store, endSession({ ...session, rests }, Date.now()))
      session = null
    }
    await bridge.shutDownPageContainer(1)
    return
  }

  // Long press starts a rest, or ends the one running. Chosen because it is the
  // one gesture nothing else uses and it is hard to trigger by accident.
  if (saw(OsEventTypeList.LONG_PRESS_EVENT)) {
    const here = following === null ? null : stopNear(model, following.along)
    rests = toggleRest(rests, {
      along: following?.along ?? 0,
      lat: position.lat,
      lon: position.lon,
      ...(here?.ele === undefined ? {} : { ele: here.ele }),
      ...(here === null ? {} : { at: here.name }),
    }, Date.now())
    // Written on every change: a hike outlasts the app, and an interrupted
    // session must not lose the log.
    void store.set(restKey, serializeRests(rests))
    if (session !== null) {
      session = { ...session, rests }
      void saveSession(store, session)
      sessionSavedAt = Date.now()
    }
    setState({ rests })
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
    position = pointAt(((following?.along ?? 0) + totalM / 24) % totalM)
    relocate(position)
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

const initialHud = currentHud()

const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 4,
  textObject: [
    new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 26,
      containerID: TITLE, containerName: 'title', zOrderIndex: 1,
      content: initialHud.title, isEventCapture: 0,
    }),
    new TextContainerProperty({
      xPosition: 300, yPosition: 32, width: 276, height: 144,
      containerID: STATS, containerName: 'stats', zOrderIndex: 3,
      content: initialHud.stats, isEventCapture: 0,
    }),
    new TextContainerProperty({
      xPosition: 0, yPosition: 182, width: 576, height: 100, paddingLength: 2,
      containerID: STATUS, containerName: 'status', zOrderIndex: 4,
      content: initialHud.status, isEventCapture: 1,
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
    menuItems: routes().slice(0, 10).map((route: RouteRecord, i: number) => new MenuItemProperty({
      itemName: menuLabel(route.name),
      itemID: i + 1,
    })),
  }),
}))

syncRestTimer()

if (result !== StartUpPageCreateResult.success) {
  // 1 invalid, 2 oversize, 3 out of memory.
  console.error('createStartUpPageContainer failed:', result)
  return 'failed'
}
await pushProfile(initialHud, true)
publish()

// A real fix takes over only once it is actually near the route.
bridge.onAppLocationChanged((location: AppLocation) => {
  const fix: LatLon = { lat: location.latitude, lon: location.longitude }
  const located = follow(model, fix, following)
  if (located === null) return

  if (located.offset > NAV_RADIUS_M) {
    // Far from every known line: say so, and leave tap stepping working rather
    // than silently reporting progress along a route nobody is walking.
    awayM = located.offset
    liveGps = false
  } else {
    awayM = null
    liveGps = true
    position = fix
    relocate(fix)
    recordWalked(fix, location.altitude)
  }
  void redraw()
})

/**
 * Add a fix to the hike in progress, starting one if this is the first.
 *
 * Only live fixes near the route are recorded — tap stepping and a phone
 * sitting at home must not manufacture a walk that never happened.
 */
function recordWalked(fix: LatLon, altitude?: number): void {
  const now = Date.now()
  if (session === null) {
    session = startSession(source.id, source.name, now)
    sessionSavedAt = 0
  }

  const next = recordFix(session, fix, altitude === undefined ? {} : { ele: altitude })
  // recordFix returns the same object when the fix was too close to matter.
  if (next === session && now - sessionSavedAt < SESSION_SAVE_MS) return
  session = { ...next, rests }
  if (now - sessionSavedAt >= SESSION_SAVE_MS) {
    sessionSavedAt = now
    void saveSession(store, session)
  }
}
void bridge.startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, distanceFilter: 10 })

// The phone page can switch route too; mirror it onto the glasses.
subscribe(() => {
  const wanted = getState().routeId
  if (wanted === source.id) return
  const chosen = routes().find(r => r.id === wanted)
  if (chosen === undefined) return
  void (async () => {
    await selectRoute(chosen)
    syncRestTimer()
    await redraw(true)
  })()
})

return 'ready'
}
