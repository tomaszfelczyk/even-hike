# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev        # vite --host (see "You cannot test this in a browser" below)
pnpm build      # tsc && vite build -> dist/
pnpm test       # typecheck tests, then node --test over src/**/*.test.ts
pnpm preview    # serve the production build
```

No linter and no `vite.config.*`. Tests run on Node's built-in runner against TypeScript directly — Node 25 strips types natively, so there is no test-framework dependency. One file: `node --test src/lib/route.test.ts`. One case: add `--test-name-pattern "off route"`.

Two tsconfigs on purpose. `tsconfig.json` types the browser app and **excludes** `*.test.ts`; `tsconfig.test.json` adds `@types/node` for the tests only, so Node globals never reach app code.

## What this actually is

This is **not a web app**. It is an Even Realities smart-glasses app that runs inside the Even App's WebView. `index.html` mounts an empty `<div id="app">` and nothing ever renders into it — the DOM exists only to host the script. The real UI is drawn on the glasses by sending container primitives over the SDK bridge (`@evenrealities/even_hub_sdk`).

`src/main.ts` is the whole app. `app.json` is the glasses-app manifest (package id, entrypoint, permissions, minimum host versions) and is the packaging contract, not build config.

### Two surfaces, one app

`src/main.tsx` renders a **React page into the WebView** (route list, stats, profile, selection) and *then* calls `startGlasses()`, which draws the HUD through SDK container primitives. `src/store.ts` is the state both share; React subscribes with `useSyncExternalStore`, the glasses controller subscribes directly. `modelFor()` builds the route model for both, so they can never disagree about a distance.

The page renders before and independently of the glasses, which is what makes the phone UI developable in an ordinary browser tab.

**Do not use `waitForEvenAppBridge()` to detect the glasses.** It resolves optimistically even with no host: every later call then logs `[EvenAppBridge] postMessage: Flutter handler not available` and `createStartUpPageContainer` quietly returns `invalid` (1), so the app looks connected and does nothing. `hasEvenAppHost()` in `src/glasses.ts` checks for `window.flutter_inappwebview.callHandler`, which is the only honest signal. `startGlasses()` returns `'unavailable' | 'failed' | 'ready'` accordingly and the page says which.

Three ways to run it, cheapest first:

1. **Node** — `pnpm test`. Everything in `src/lib/` is SDK-free and asserted here, including `toAscii()` previews of the elevation profile.
2. **Browser** — `pnpm dev`, then open `localhost:5173`. The React page works fully; the glasses report `unavailable`. This is the place to build the phone UI.
3. **Simulator / real glasses** — `pnpm sim` alongside the dev server, or `pnpm qr` and scan it from the phone app. Sideloading needs developer mode: sign in at hub.evenrealities.com/login, then force-quit and reopen the phone app so **Scan QR** appears in the Even Hub tab. Phone and laptop must share a network without AP isolation — that is the usual cause of a scan that never loads.

`pnpm pack` produces a `.ehpk` from `app.json` + `dist/` for distribution.

### The UI library

`@jappyjan/even-realities-ui` (Badge, Button, Card, Checkbox, Chip, Divider, IconButton, Input, Radio, Select, Switch, Text, Textarea, plus icons and tokens) is **React DOM only** — it renders on the phone page and cannot draw on the glasses. Import its stylesheet from `@jappyjan/even-realities-ui/styles`; `src/globals.d.ts` declares that subpath since it ships no types for it.

## Saving routes

`RouteRecord` is the one shape both surfaces use, whether a route is compiled into the build (`src/routes.ts`, `builtIn: true`) or imported by the user. All of a route's paths live in one list — main legs *and* alternatives — because `buildRoute` already works out which is which.

`src/lib/route-store.ts` persists them over a `KeyValueStore`, which is pure enough to test against an in-memory map. Three properties of the host store shape it:

- **Values are strings** — hence `src/lib/codec.ts`. Never store raw GPX: the 24.6 km route is 155 KB of XML against ~13 KB delta-encoded, and the host's size ceiling is undocumented with no chunking. Coordinates quantise to 1e-5 deg (~1 m), elevation to 1 m, which moves a route's total ascent by a few metres out of ~1700 and its length by well under 0.2%.
- **There is no delete** — removal blanks the value *and* drops the id from the manifest, manifest first, so a half-finished delete still reads as gone.
- **Keys cannot be enumerated** — `routes:index` is the manifest that defines the set. A value with no manifest entry is invisible by design.

`parseRoute` returns null rather than throwing, and `loadRoutes` skips unreadable entries, so one corrupt record cannot hide the rest. Decoding stops at the first malformed field rather than continuing, because every point is a delta from the last.

`src/storage.ts` picks the backing store: the host on the glasses, `localStorage` in a browser tab. That is what lets routes be imported and deleted while developing the page with no hardware. Reads await the bridge rather than guessing, so the page cannot read one store while the glasses write another.

## The image is the expensive part

Text updates are cheap; the profile is 288x144, about **41 KB before LZ4**, and it crosses a BLE link. `pushProfile` therefore throttles hard where `textContainerUpgrade` does not:

- It only pushes when the marker crosses a **pixel** — on a 20 km route that is 69 m of walking.
- At most one push every `PROFILE_MIN_INTERVAL_MS` (4 s), and never two at once. A burst of fixes schedules **one** trailing push for the newest state rather than queueing a dozen stale ones.
- A failed push clears the dedupe key, so the next attempt is not suppressed by a frame that never arrived.

If the profile looks frozen on device, this is the first place to look — the symptom of pushing too often is a picture that stops keeping pace, not one that errors.

## Hike history

`src/lib/history.ts` records what happened, as distinct from the route, which is the plan. Comparing the two is the point of keeping it: `elapsedMs` includes rest, `movingMs` does not, and `walkedDistance` comes from the trace rather than the plan.

**The trace is thinned on the way in** (`TRACE_SPACING_M`, 25 m) while routes are stored at full density. Navigation projects onto a route, so its detail matters; a trace is only reviewed. On a 20 km walk that is ~6 KB instead of ~14 KB, and hikes accumulate forever while routes do not. That difference is what keeps a key/value store viable here — see the note under **Storing data** for where it stops being viable.

Recording only happens on live fixes near the route. Tap stepping and a phone sitting at home must not manufacture a walk that never happened.

Writes are throttled to every 30 s (`SESSION_SAVE_MS`). Fixes arrive every few metres for hours, and writing on each would push a growing blob across the bridge thousands of times; 30 s bounds the loss to the last half minute of walking. `recordFix` returns **the same object** when a fix was too close to matter, so callers can skip a write by identity.

A hike ends on exit or on switching route — it belongs to the route it was walked on. An unfinished one is resumed if it is recent (`resumableSession`, 12 h), so closing the app mid-walk does not split one afternoon into two records; an unfinished hike from last month is abandoned, not in progress.

## Following, and the HUD both surfaces render

`src/lib/hud.ts` computes **what the display says** — title, stats, status, and the profile parameters — as pure data. The glasses push those strings into text containers; the phone page renders the same values into a 576x288 box (`src/ui/Hud.tsx`, laid out in the glasses' own coordinates and scaled). One implementation, so the mirror cannot drift from the thing it mirrors, and the wording is testable without hardware.

`src/lib/follow.ts` decides **which line the walker is on**. `progressOn` projects onto the main route alone, which is wrong the moment an alternative is taken — walking the long way to the hut would read as four kilometres of being off route. `follow()` considers the main line and every variant, maps progress along a variant onto its branch..rejoin span, and reports which is underfoot.

Two things it needs that are easy to leave out:

- **Hysteresis** (`switchMarginM`, default 20 m). At a junction both lines are literally underfoot, so without a margin the display swaps on every fix as noise nudges the projection. A newcomer has to be clearly closer, not merely closer.
- **`changed` fires once**, on the update where the line actually changed, which is what drives the banner. `lineChangeNotice` turns it into `TAKING LONG WAY  +4.2km +424m` or `BACK ON MAIN ROUTE`; `glasses.ts` holds it on the status line for 12 s.

Status-line priority, most urgent first: a line-change notice, being far from the route entirely, off route, which alternative is being walked, an approaching junction, an imminent sight, standing at a stop, the next stop, then plain "on route".

## Same walk, not a second route

`src/lib/merge.ts` decides whether an imported GPX is a new route or another way round one already held. Same start, same finish, same stops (within 150 m — trailhead and hut pins wander between exports) means the same walk, in either direction, since two exports of one traverse routinely run opposite ways.

When it matches, `mergeAsVariants` folds in only the legs that differ and drops the ones already held, so a shared leg is never stored twice — a duplicate would otherwise surface as a zero-delta "alternative". This is the point of it: the choice then reaches the walker **on the glasses at the junction**, instead of sitting in a route picker they would have to stop and open.

`samePath` is what separates a shared leg from two ways round, and endpoints alone cannot do it — sharing both ends is exactly what makes two ways round *different*. Lengths have to agree as well (within 5%).

The bundled `tatry-zawrat` follows the same rule by hand: the long approach to Murowaniec is an extra path on that record, not a route of its own.

## Multiple routes

`src/routes.ts` holds the bundled routes as `RouteSource` records — id, name, GPX text, optional alternatives, stop names, planned rest. `selectRoute()` in `main.ts` rebuilds every route-dependent value from one of them, so adding a route is one entry in that array.

The picker is the SDK's **contextual menu**, set once at page creation (itemIDs 1..n, max 10, labels folded and trimmed to 32 UTF-8 bytes — the firmware rejects an over-long name silently). The container layout is identical across routes, so switching is only a text and image update, never a `rebuildPageContainer`.

Rest logs are keyed `rests:<route id>` and the chosen route is remembered under `route:selected`, so switching mid-hike parks one log and resumes the other rather than merging two days of walking.

**`@jappyjan/even-realities-ui` cannot draw any of this.** It is a React DOM library (`react ^19`, tailwind-merge), so it belongs to the phone-side page in the WebView — the GPX loader and route manager that are still to be built. The glasses are drawn with SDK container primitives and nothing else; `<div id="app">` stays empty.

## Stops

`joinLegs()` records the point indices where legs met, and `buildRoute()` turns those into `model.stops`. The reasoning: a route exported as several `<trk>` elements was usually *split at the places the walker planned to pause*. On the bundled Tatra route the two junctions land at 1515 m and 1686 m — hut altitudes, not arbitrary waypoints.

`restSeconds` defaults to **0**, so rest never appears in an estimate uninvited; `main.ts` sets it explicitly. `Progress` separates `remainingTime` (walking only) from `remainingRest`, with `remainingTotal` as the sum — and the display uses the total, because a finish estimate that quietly ignores planned rest is the one that gets people caught out after dark.

GPX junctions carry no names and this file has no `<wpt>` elements to borrow them from, so `stopNames` in `BuildOptions` supplies them in order (currently Murowaniec and PTTK Pięć Stawów). Positions still come from the data, so re-exporting the route keeps the names attached to the right places. `stops` replaces the inferred list outright when per-stop rest is wanted too.

Stop names are stored with their real spelling and folded only at display, via `foldAscii()` — the same helper `displayTitle` uses.

Watch out when editing `joinLegs`: junction indices have to be remapped when a leg is chained backwards, which happens whenever two exports of the same ground run in opposite directions. There is a test pinning that.

## Segments and the scroll views

`segmentsOf(model)` splits the route at its stops. With no stops it returns one segment covering the whole walk, so callers never special-case an unsegmented route. `main.ts` maps scroll events onto these: view 0 is the whole hike (live progress), views 1..n are the legs between stops (fixed spans — distance, climb and walking time for that leg, with the profile zoomed to it).

Event-handling order matters in that callback. Because a tap arrives with `eventType` absent and is resolved by defaulting to `CLICK_EVENT`, **CLICK must be tested last** — otherwise every scroll and double-tap is swallowed as a tap. Scroll arrives as `SCROLL_TOP_EVENT` (1) / `SCROLL_BOTTOM_EVENT` (2), which are non-zero and therefore present on the wire.

## Storing data

`bridge.setLocalStorage(key, value)` / `getLocalStorage(key)` is the host-side store, and it is **strings only, with no delete and no way to list keys**. A missing key returns `''`, indistinguishable from one set to empty. So anything multi-record needs its own manifest key, and deletion means writing `''` plus removing the id from that manifest.

There is no SDK-side chunking or size guard — whatever the host accepts is the limit, and that limit is undocumented and untested on hardware. Verify it with one large write before designing around it.

**Never store raw GPX.** The bundled 24.6 km route is 155 KB of XML crossing the bridge in a single JSON message. Delta-encoded (fixed-point deltas of lat/lon to 1e-5 deg and elevation to 1 m, base36) the same 1839 points are **13.2 KB, lossless** at ~1 m coordinate resolution.

Do not thin the track to save more: dropping points below 10 m spacing gets to 8.2 KB but costs 478 m of route length (corners get cut), and 20 m costs 866 m. Five kilobytes is not worth two percent of the distance.

Route annotations — display name, stop names, per-stop rest, terrain factor — are about 0.2 KB and belong in their own key next to the geometry.

## Rests taken vs rest planned

`src/lib/rests.ts` records rests as they happen — start, end, position, and the stop they were at. It is kept separate from a `Stop`'s `restSeconds`, which is an estimate baked into the route. Comparing the two is the point: *rested 22m of 15m planned* is what tells a walker they are running late, and merging them would destroy it.

**Long press** toggles a rest, chosen because nothing else uses it and it is hard to hit by accident. In the event handler it must be tested before CLICK, like scroll, for the `eventType`-defaulting reason above.

The log is written to host storage on **every** change, under a key namespaced by route. A hike outlasts the app, so `parseRests` never throws: a `''` from an unwritten key, truncated JSON, or malformed entries all degrade to dropping what is unreadable and keeping the rest. An open rest survives a reload and keeps running.

Starting a rest closes any rest left open, so there is never more than one running. Durations clamp at zero, so a clock that jumps backwards cannot produce negative rest.

While a rest is running, nothing else generates events — a 30 s interval drives the redraw so the displayed minute is never stale, and it is cleared the moment the rest ends.

## Sights are not stops

`model.waypoints` holds GPX `<wpt>` elements projected onto the route (`along`, `offset`, `ele`), fed in through `waypoints` in `BuildOptions`. They are deliberately a separate layer from `stops`: a hut is somewhere you pause and it costs time, a viewpoint is somewhere you look. Folding them together would inflate every finish estimate with rest nobody is taking — there is a test asserting that adding sights changes `remainingTotal` by exactly nothing.

Waypoints further than `waypointRadiusM` (default 1000) from the line are dropped, since an export can carry markers from elsewhere. `offset` is recorded rather than hidden, so a summit a little off the trail can say so.

On the profile, stops tick 6 px and sights 3 px. In the status line a sight only interrupts within 400 m of arriving; otherwise the next stop holds the line.

AllTrails' "Top sights" are **not** in a GPX export — the current files contain only `<trkpt>`/`<ele>` plus names. Adding waypoints to a custom route on their website does export them as `<wpt>`, which is the path this layer is built for.

## Walking time

`hikingTime()` uses **Tobler's function**, integrating speed per segment from the gradient, and is what every time on screen comes from. `naismith()` is still exported but is the weaker model and is no longer wired in.

The reason is descent. Naismith takes two numbers — distance and total ascent — and charges *nothing* for going down. On this Tatra route that hides 1h24 of steep downhill: Naismith says 7h46 where Tobler says 8h54, against AllTrails' own 10.5–11.5 h. Tobler peaks at 6 km/h on a gentle 2.9° descent and falls away in both directions.

Tobler **requires smoothed elevation**. At ~8 m sampling, raw jitter makes every segment look near-vertical and the speed term collapses — on this route raw input adds 1h13 of pure noise. `buildRoute` smooths first, so anything going through the model is safe; calling `hikingTime` on raw points directly is not.

`terrainFactor` (default 1, unmodified) scales for ground the original fit does not cover — scrambling, chains, scree. Matching AllTrails on this route would need 1.18–1.29; under Naismith it needed 1.35–1.48. Calibrate it against a real walk rather than against another app's guess.

## Elevation profile

`renderProfile()` in `src/lib/profile.ts` draws a profile as a grayscale bitmap for an SDK image container, and `toAscii()` previews it in a terminal — the only way to eyeball one without hardware.

The hard limit is the firmware's: `ImageContainerProperty` accepts **20–288 wide and 20–144 high**, so a profile occupies at most half the 576×288 canvas in each dimension. A 288×144 bitmap is 41,472 bytes before the SDK's internal LZ4 pass.

Fill defaults to on; a hairline is hard to read on a mono display at this size. Columns average the elevation of every sample that falls in them (at 288 px a 25 km route puts ~85 m of trail per column), and adjacent columns are joined vertically so steep ground stays a continuous ridge rather than dotted pixels.

Note when comparing against AllTrails' own chart: its axis labels are padded by **10% of the elevation range** above and below, so they are not the data's min and max. This model's default padding is 0.04, since on 144 px their 10% spends a fifth of the height on nothing.

## Glasses page lifecycle

`createStartUpPageContainer` must be the first glasses-UI call; other operations are rejected before it. It returns a `StartUpPageCreateResult` (`0` success, `1` invalid, `2` oversize, `3` outOfMemory) rather than throwing — always check it.

After that: `textContainerUpgrade` to change text in place, `rebuildPageContainer` to change layout, `shutDownPageContainer(1)` to exit. Mode `1` shows the system exit-confirmation dialog and is required on the root page; mode `0` exits silently.

Container rules enforced by the SDK or firmware:
- `containerTotalNum` 1–12; max 8 text objects.
- Exactly one container sets `isEventCapture: 1` — that is what makes input reach the page.
- `zOrderIndex` is all-or-nothing per page and must be unique; violating this fails the whole page.
- `textColor` is 0–4 (omit to keep current brightness). Image containers are 20–288 wide, 20–144 high, and need `updateImageRawData` after creation.

## Event handling — read this before touching the handler

Every OS event arrives through the single `bridge.onEvenHubEvent` callback. You route by *which envelope is present* on the event object (`sysEvent`, `textEvent`, `listEvent`, `audioEvent`, `menuItemClickEvent`), not by a type tag.

Two facts that are easy to get wrong, and have already caused one regression here:

1. **Taps, double-taps and lifecycle events come through `sysEvent`; scroll gestures come through `textEvent`.** A handler that only inspects `textEvent` silently drops every tap.

2. **`CLICK_EVENT` is `0`, and proto3 omits zero-valued fields on the wire, so a real tap arrives with `eventType === undefined`.** Treating `undefined` as "no event" drops all taps.

Because of (2), the `?? CLICK_EVENT` default must be resolved *inside* a check that the envelope exists:

```ts
// correct
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }) {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// wrong: reads CLICK on every event that has no sysEvent at all,
// so audio frames and lifecycle pushes fire the tap handler
event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT
```

Check `DOUBLE_CLICK_EVENT` before `CLICK_EVENT`, and keep the double-tap exit reachable from whichever envelope carries it so the user can always leave the app.

## Working against the SDK

`node_modules/@evenrealities/even_hub_sdk/dist/index.js` is obfuscated and not worth reading. The two useful sources are `dist/index.d.ts` (heavily documented, partly in Chinese) and `README.md`.

To exercise bridge behavior without hardware, the SDK installs a global `_listenEvenAppMessage` that the host calls to push events in. You can stand up a fake host in Node — define `window`/`document` over an `EventTarget`, stub `flutter_inappwebview.callHandler`, import the SDK, then push:

```js
_listenEvenAppMessage({ method: 'evenHubEvent', data: { type: 'sysEvent', jsonData: { EventSource: 1 } } })
```

`{ method, data }` is the shape the dispatcher accepts; `{ type: 'evenHubEvent', ... }` is dropped with an `Unknown message method` log. **Omit zero-valued fields in mock payloads** — sending `Event_Type: 0` explicitly produces a payload the real host never sends and will make a broken handler look correct.

## Version coupling

`app.json`'s `min_app_version` / `min_sdk_version` must track the installed SDK, which declares its own `minAppVersion` in its `package.json` (0.0.15 requires Even App 2.2.10). Event delivery shapes differ across host versions, so letting the manifest admit older hosts than the SDK supports produces undefined runtime behavior rather than a clean failure.

## TypeScript config gotchas

`tsconfig.json` enables `verbatimModuleSyntax` (type-only imports need the `type` keyword), `noUnusedLocals`/`noUnusedParameters` (an unused binding fails the build), and `erasableSyntaxOnly` (no `enum`, `namespace`, or parameter properties in app code — importing the SDK's enums is fine).
