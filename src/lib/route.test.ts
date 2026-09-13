import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromGeoJson, parseGpx, toGeoJson } from './gpx.ts'
import {
  buildRoute, displayTitle, foldAscii, formatDelta, joinLegs, nextStop, nextWaypoint, segmentsOf, nextDecision, progressOn, variantLabel, variantsAhead,
} from './route.ts'
import { pathLength } from './geo.ts'

const near = (actual: number, expected: number, tol: number, what = '') =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what} expected ~${expected} (±${tol}), got ${actual}`)

const utf8 = (s: string) => new TextEncoder().encode(s).length

/**
 * Hand-built fixture with geometry that can be checked on paper.
 *
 * Main line runs west->east at lat 47 but bulges north to a 200 m saddle:
 *   A(-122.000,100) - B(-121.990,100) - C(47.005,-121.985,200) - D(-121.980,100) - E(-121.970,100)
 * At lat 47, 0.010 deg of longitude is ~758 m and 0.005 deg of latitude ~556 m,
 * so the legs are ~758, ~673, ~673, ~758 => ~2863 m total, 100 m of climb.
 *
 * Also exercises the parser: two <trkseg>s in one track, CDATA, an entity,
 * a <rte> alongside <trk>, a comment, and a detached track.
 */
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <!-- exported for testing -->
  <wpt lat="47.005" lon="-121.985"><ele>200</ele><name>Eagle Saddle</name></wpt>
  <trk>
    <name><![CDATA[Eagle Peak Loop]]></name>
    <trkseg>
      <trkpt lat="47.000" lon="-122.000"><ele>100</ele></trkpt>
      <trkpt lat="47.000" lon="-121.990"><ele>100</ele></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="47.005" lon="-121.985"><ele>200</ele></trkpt>
      <trkpt lat="47.000" lon="-121.980"><ele>100</ele></trkpt>
      <trkpt lat="47.000" lon="-121.970"><ele>100</ele></trkpt>
    </trkseg>
  </trk>
  <trk>
    <name>Short cut</name>
    <trkseg>
      <trkpt lat="47.000" lon="-121.990"><ele>100</ele></trkpt>
      <trkpt lat="47.000" lon="-121.980"><ele>100</ele></trkpt>
    </trkseg>
  </trk>
  <rte>
    <name>Ridge spur &amp; lookout</name>
    <rtept lat="47.005" lon="-121.985"><ele>200</ele></rtept>
    <rtept lat="47.010" lon="-121.985"><ele>350</ele></rtept>
  </rte>
  <trk>
    <name>Somewhere else entirely</name>
    <trkseg>
      <trkpt lat="48.000" lon="-120.000"><ele>50</ele></trkpt>
      <trkpt lat="48.001" lon="-120.000"><ele>50</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`

const doc = parseGpx(FIXTURE)
const model = buildRoute(doc.paths)!

test('parses every track and route in one file', () => {
  assert.deepEqual(doc.paths.map(p => p.name),
    ['Eagle Peak Loop', 'Short cut', 'Somewhere else entirely', 'Ridge spur & lookout'])
  assert.deepEqual(doc.paths.map(p => p.kind), ['track', 'track', 'track', 'route'])
})

test('concatenates track segments and reads elevation', () => {
  const main = doc.paths[0]
  assert.equal(main.points.length, 5, 'two <trkseg>s form one continuous line')
  assert.deepEqual(main.points.map(p => p.ele), [100, 100, 200, 100, 100])
})

test('decodes CDATA and character entities in names', () => {
  assert.equal(doc.paths[0].name, 'Eagle Peak Loop')
  assert.equal(doc.paths[3].name, 'Ridge spur & lookout')
})

test('reads standalone waypoints', () => {
  assert.deepEqual(doc.waypoints, [{ name: 'Eagle Saddle', point: { lat: 47.005, lon: -121.985, ele: 200 } }])
})

test('picks the longest path as the main route', () => {
  assert.equal(model.main.name, 'Eagle Peak Loop')
  near(model.mainLength, 2862.6, 5, 'main length')
  assert.equal(model.mainAscent, 100)
})

test('a shortcut reports negative distance and negative climb', () => {
  const cut = model.variants.find(v => v.path.name === 'Short cut')!
  assert.ok(cut, 'shortcut was matched to the main line')
  near(cut.branchAlong, 758.4, 5, 'branches at B')
  near(cut.rejoinAlong!, 2104.3, 5, 'rejoins at D')
  // Skips the 1346 m saddle detour in 758 m.
  near(cut.deltaDistance, -587.6, 5, 'distance saved')
  near(cut.deltaAscent, -100, 1, 'climb avoided')
  assert.ok(cut.deltaTime < 0, 'and it is quicker')
})

test('a spur with one touch point is costed as an out-and-back', () => {
  const spur = model.variants.find(v => v.path.name === 'Ridge spur & lookout')!
  assert.ok(spur)
  assert.equal(spur.rejoinAlong, null, 'never rejoins, so it is walked twice')
  near(spur.branchAlong, 1431.3, 5, 'branches at the saddle')
  near(spur.deltaDistance, 1111.9, 5, '556 m out and 556 m back')
  near(spur.deltaAscent, 150, 1, 'climb counts once; the return leg descends')
})

test('unconnected paths are separated, not silently treated as variants', () => {
  assert.deepEqual(model.detached.map(p => p.name), ['Somewhere else entirely'])
  assert.equal(model.variants.length, 2)
})

test('variants are ordered by where they branch', () => {
  assert.deepEqual(model.variants.map(v => v.path.name), ['Short cut', 'Ridge spur & lookout'])
})

test('only offers variants that are still ahead', () => {
  assert.equal(variantsAhead(model, 0).length, 2)
  assert.deepEqual(variantsAhead(model, 1000).map(v => v.path.name), ['Ridge spur & lookout'])
  assert.equal(variantsAhead(model, 2500).length, 0, 'nothing left to choose near the end')
  // A branch just behind stays offered, so GPS wander at a junction
  // does not make the option disappear as the walker arrives.
  assert.equal(variantsAhead(model, 780).length, 2)
})

test('nextDecision surfaces a junction only once it is close', () => {
  assert.equal(nextDecision(model, 0, 400), null, 'still 758 m out')
  assert.equal(nextDecision(model, 500, 400)?.path.name, 'Short cut')
  assert.equal(nextDecision(model, 1200, 400)?.path.name, 'Ridge spur & lookout')
})

test('progress tracks distance and climb still to come', () => {
  const atB = progressOn(model, { lat: 47.0, lon: -121.99 })!
  near(atB.along, 758.4, 5, 'along')
  near(atB.offset, 0, 1, 'on the line')
  assert.equal(atB.onRoute, true)
  near(atB.remainingDistance, 2104.3, 5, 'distance left')
  assert.equal(atB.remainingAscent, 100, 'the saddle is still ahead')
  assert.ok(atB.remainingTime > 0)
})

test('detects being off route', () => {
  const strayed = progressOn(model, { lat: 47.001, lon: -121.995 })!
  near(strayed.offset, 111.2, 2, 'about 111 m north of the line')
  assert.equal(strayed.onRoute, false)
  assert.equal(progressOn(model, { lat: 47.0001, lon: -121.995 })!.onRoute, true)
})

test('menu labels stay inside the 32-byte firmware cap', () => {
  for (const variant of model.variants) {
    const label = variantLabel(variant)
    assert.ok(utf8(label) <= 32, `"${label}" is ${utf8(label)} bytes`)
    assert.ok(label.includes('km'), 'the number survives trimming')
  }
  const spur = model.variants.find(v => v.path.name === 'Ridge spur & lookout')!
  assert.ok(variantLabel(spur).startsWith('Ridge spur'), 'name is trimmed from the end')
  assert.equal(formatDelta(spur), '+1.1km +150m')
})

test('label degrades to just the numbers when the budget is tiny', () => {
  const cut = model.variants.find(v => v.path.name === 'Short cut')!
  assert.equal(variantLabel(cut, 8), formatDelta(cut))
})

test('GeoJSON round-trips paths, elevation and waypoints', () => {
  const back = fromGeoJson(toGeoJson(doc))
  assert.deepEqual(back.paths.map(p => p.name), doc.paths.map(p => p.name))
  assert.deepEqual(back.paths.map(p => p.kind), doc.paths.map(p => p.kind))
  assert.deepEqual(back.paths[0].points, doc.paths[0].points)
  assert.deepEqual(back.waypoints, doc.waypoints)
  // And the model rebuilds identically from the round-tripped copy.
  const rebuilt = buildRoute(back.paths)!
  near(rebuilt.mainLength, model.mainLength, 0.001, 'length survives')
  assert.deepEqual(rebuilt.variants.map(v => v.path.name), model.variants.map(v => v.path.name))
})

test('empty and malformed input do not throw', () => {
  assert.deepEqual(parseGpx('').paths, [])
  assert.deepEqual(parseGpx('<gpx></gpx>').paths, [])
  assert.equal(buildRoute([]), null)
  // Points missing lat/lon are dropped rather than poisoning the line with NaN.
  const partial = parseGpx('<gpx><trk><name>x</name><trkseg>' +
    '<trkpt lat="47" lon="-122"/><trkpt lon="-122"/></trkseg></trk></gpx>')
  assert.equal(partial.paths[0].points.length, 1)
})

/**
 * A main line with two northward bulges, and an alternative that cuts both
 * while sharing the straight stretch between them. Two separate decisions.
 */
const TWO_DETOURS = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Main</name><trkseg>
    <trkpt lat="47.000" lon="-122.000"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.990"><ele>100</ele></trkpt>
    <trkpt lat="47.005" lon="-121.985"><ele>200</ele></trkpt>
    <trkpt lat="47.000" lon="-121.980"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.970"><ele>100</ele></trkpt>
    <trkpt lat="47.005" lon="-121.965"><ele>200</ele></trkpt>
    <trkpt lat="47.000" lon="-121.960"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.950"><ele>100</ele></trkpt>
  </trkseg></trk>
  <trk><name>Low road</name><trkseg>
    <trkpt lat="47.000" lon="-121.990"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.980"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.970"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.960"><ele>100</ele></trkpt>
  </trkseg></trk>
</gpx>`

test('one alternative can diverge more than once', () => {
  const two = buildRoute(parseGpx(TWO_DETOURS).paths)!
  assert.equal(two.main.name, 'Main')
  assert.equal(two.variants.length, 2, 'both bulges are separate decisions')

  const [first, second] = two.variants
  near(first.branchAlong, 758.4, 5, 'first bulge')
  near(first.rejoinAlong!, 2104.3, 5)
  near(second.branchAlong, 2862.6, 5, 'second bulge')
  near(second.rejoinAlong!, 4208.5, 5)
  for (const v of two.variants) {
    near(v.deltaDistance, -587.6, 5, 'each cuts the same amount')
    near(v.deltaAscent, -100, 1)
  }
})

test('the shared stretch between detours is not itself reported', () => {
  const two = buildRoute(parseGpx(TWO_DETOURS).paths)!
  // Points 2 and 3 of the alternative run along the main line: same distance
  // either way, so there is no choice to offer there.
  assert.ok(two.variants.every(v => Math.abs(v.deltaDistance) > 100))
})

test('insignificant differences are filtered by time, not distance', () => {
  const paths = parseGpx(TWO_DETOURS).paths
  // Each bulge is worth about 14 minutes of walking under Tobler.
  assert.equal(buildRoute(paths, { minDetourSeconds: 700 })!.variants.length, 2)
  assert.equal(buildRoute(paths, { minDetourSeconds: 900 })!.variants.length, 0)
})

test('joinLegs chains consecutive tracks but leaves variants alone', () => {
  const split = parseGpx(`<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Leg 1</name><trkseg>
    <trkpt lat="47.000" lon="-122.000"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.990"><ele>100</ele></trkpt>
  </trkseg></trk>
  <trk><name>Leg 2</name><trkseg>
    <trkpt lat="47.000" lon="-121.990"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.980"><ele>100</ele></trkpt>
  </trkseg></trk>
</gpx>`)
  const joined = joinLegs(split.paths)
  assert.equal(joined.length, 1, 'end-to-start contact chains the legs')
  assert.equal(joined[0].points.length, 3, 'the shared junction is kept once')
  near(pathLength(joined[0].points), 1516.7, 5, 'full length, not one leg')

  // The fixture's variants branch from interior points, so none of them chain.
  assert.equal(joinLegs(doc.paths).length, doc.paths.length)
})

test('titles are folded to characters the firmware font is known to carry', () => {
  const folded = displayTitle('Custom route — Tatry Wysokie: Palenica Białczańska - Kuźnice')
  assert.ok(/^[\x20-\x7E]*$/.test(folded), `"${folded}" should be plain ASCII`)
  // The l-stroke has no NFD decomposition, so it needs handling of its own or
  // it is simply deleted, turning Białczańska into Biaczaska.
  assert.ok(folded.includes('Bialczanska'), folded)
  assert.ok(folded.includes('Kuznice'), 'the destination is the part worth keeping')
})

test('an over-long title sheds its prefix before its tail', () => {
  assert.equal(
    displayTitle('Custom route — Tatry Wysokie: Palenica Białczańska - Kuźnice', 52),
    'Palenica Bialczanska - Kuznice',
  )
  // Nothing to shed: cut the tail as a last resort.
  assert.equal(displayTitle('A'.repeat(80), 52).length, 52)
  // The route's own name fits whole at the default budget.
  assert.equal(
    displayTitle('Tatry Wysokie: Kuźnice - Zawrat - Palenica Białczańska'),
    'Tatry Wysokie: Kuznice - Zawrat - Palenica Bialczanska',
  )
  // Already short enough: left exactly alone.
  assert.equal(displayTitle('Short one'), 'Short one')
})

const SPLIT_LEGS = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Leg 1</name><trkseg>
    <trkpt lat="47.000" lon="-122.000"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>
  </trkseg></trk>
  <trk><name>Leg 2</name><trkseg>
    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>
    <trkpt lat="47.000" lon="-121.980"><ele>500</ele></trkpt>
  </trkseg></trk>
  <trk><name>Leg 3</name><trkseg>
    <trkpt lat="47.000" lon="-121.980"><ele>500</ele></trkpt>
    <trkpt lat="47.000" lon="-121.970"><ele>400</ele></trkpt>
  </trkseg></trk>
</gpx>`

test('stops are inferred from the points where legs meet', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths, { restSeconds: 600 })!
  assert.equal(m.stops.length, 2, 'three legs meet at two places')
  near(m.stops[0].along, 758.4, 5, 'first junction')
  near(m.stops[1].along, 1516.7, 5, 'second junction')
  assert.deepEqual(m.stops.map(s => s.ele), [300, 500], 'each carries its altitude')
  assert.deepEqual(m.stops.map(s => s.restSeconds), [600, 600])
})

test('a route that was never split has no stops', () => {
  assert.deepEqual(buildRoute(parseGpx(TWO_DETOURS).paths, { restSeconds: 600 })!.stops, [])
  // Chaining off means no junctions are recorded either.
  assert.deepEqual(buildRoute(parseGpx(SPLIT_LEGS).paths, { joinLegsM: false })!.stops, [])
})

test('rest counts towards the finish estimate and drops away behind you', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths, { restSeconds: 600 })!
  const start = progressOn(m, m.main.points[0])!
  assert.equal(start.remainingRest, 1200, 'both stops still ahead')
  assert.equal(start.remainingTotal, start.remainingTime + start.remainingRest)
  assert.ok(start.remainingTotal > start.remainingTime, 'rest is not free')

  const end = progressOn(m, m.main.points[m.main.points.length - 1])!
  assert.equal(end.remainingRest, 0, 'nothing left to stop for')
  assert.equal(end.remainingTotal, end.remainingTime)
})

test('rest defaults to zero so it never appears uninvited', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths)!
  assert.equal(m.stops.length, 2, 'the junctions are still recorded')
  assert.equal(progressOn(m, m.main.points[0])!.remainingRest, 0)
})

test('explicit stops override the inferred ones', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths, {
    stops: [{ along: 1200, name: 'Murowaniec', restSeconds: 1800 }],
  })!
  assert.deepEqual(m.stops.map(s => s.name), ['Murowaniec'])
  assert.equal(nextStop(m, 0)?.name, 'Murowaniec')
  assert.equal(nextStop(m, 1500), null, 'past it, there is no next stop')
})

test('junction indices survive a leg being reversed on the way in', () => {
  // Leg 2 drawn backwards: it must still chain, and the join must land in the
  // same place as if it had been drawn forwards.
  const reversed = SPLIT_LEGS.replace(
    `    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>
    <trkpt lat="47.000" lon="-121.980"><ele>500</ele></trkpt>`,
    `    <trkpt lat="47.000" lon="-121.980"><ele>500</ele></trkpt>
    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>`)
  const m = buildRoute(parseGpx(reversed).paths, { restSeconds: 600 })!
  assert.equal(m.stops.length, 2)
  near(m.stops[0].along, 758.4, 5)
  near(m.stops[1].along, 1516.7, 5)
})

test('inferred stops take names from options but keep positions from the data', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths, {
    restSeconds: 600,
    stopNames: ['Murowaniec', 'PTTK Pięć Stawów'],
  })!
  assert.deepEqual(m.stops.map(s => s.name), ['Murowaniec', 'PTTK Pięć Stawów'])
  near(m.stops[0].along, 758.4, 5, 'position still comes from the junction')
  // Real spelling is kept in the model; folding is a display concern.
  assert.equal(foldAscii(m.stops[1].name), 'PTTK Piec Stawow')
})

test('missing names fall back rather than leaving a stop unlabelled', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths, { stopNames: ['Murowaniec'] })!
  assert.deepEqual(m.stops.map(s => s.name), ['Murowaniec', 'Stop 2'])
})

test('foldAscii handles the Polish letters a naive stripper loses', () => {
  assert.equal(foldAscii('PTTK Pięć Stawów'), 'PTTK Piec Stawow')
  assert.equal(foldAscii('Kuźnice'), 'Kuznice')
  // The l-stroke has no NFD decomposition and would otherwise vanish entirely.
  assert.equal(foldAscii('Białczańska'), 'Bialczanska')
  assert.equal(foldAscii('Hala Gąsienicowa'), 'Hala Gasienicowa')
})

test('segments are the spans between stops', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths, { stopNames: ['Hut A', 'Hut B'] })!
  const segs = segmentsOf(m)
  assert.equal(segs.length, 3, 'two stops cut the route into three legs')
  assert.deepEqual(segs.map(s => `${s.from}->${s.to}`),
    ['Start->Hut A', 'Hut A->Hut B', 'Hut B->Finish'])
  near(segs[0].distance, 758.4, 5)
  near(segs[1].distance, 758.3, 5)
  // The legs tile the route exactly, with no gap and no overlap.
  near(segs.reduce((sum, s) => sum + s.distance, 0), m.mainLength, 1, 'segments tile the route')
  assert.equal(segs[0].fromAlong, 0)
  near(segs[2].toAlong, m.mainLength, 1)
})

test('segment climb and time match the ground they cover', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths, { stopNames: ['Hut A', 'Hut B'] })!
  const segs = segmentsOf(m)
  // Legs climb 100->300, 300->500, then descend 500->400.
  near(segs[0].ascent, 200, 1)
  near(segs[1].ascent, 200, 1)
  assert.equal(segs[2].ascent, 0, 'the last leg only descends')
  assert.ok(segs.every(s => s.time > 0), 'descending still takes time')
})

test('a route with no stops is one segment, not zero', () => {
  const segs = segmentsOf(buildRoute(parseGpx(TWO_DETOURS).paths)!)
  assert.equal(segs.length, 1, 'callers never need to special-case this')
  assert.equal(segs[0].from, 'Start')
  assert.equal(segs[0].to, 'Finish')
})

test('segment endpoint names can be overridden', () => {
  const m = buildRoute(parseGpx(SPLIT_LEGS).paths, { stopNames: ['Hut A', 'Hut B'] })!
  const segs = segmentsOf(m, 'Kuznice', 'Palenica')
  assert.equal(segs[0].from, 'Kuznice')
  assert.equal(segs[segs.length - 1].to, 'Palenica')
})

/**
 * Three sequential legs plus a second way to cover the first one. The two
 * options share both endpoints, which is exactly what naive end-to-end
 * chaining mistakes for a continuation.
 */
const TWO_WAYS_FIRST_LEG = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Direct</name><trkseg>
    <trkpt lat="47.000" lon="-122.000"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>
  </trkseg></trk>
  <trk><name>Leg 2</name><trkseg>
    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>
    <trkpt lat="47.000" lon="-121.980"><ele>500</ele></trkpt>
  </trkseg></trk>
  <trk><name>Leg 3</name><trkseg>
    <trkpt lat="47.000" lon="-121.980"><ele>500</ele></trkpt>
    <trkpt lat="47.000" lon="-121.970"><ele>400</ele></trkpt>
  </trkseg></trk>
  <trk><name>Long way</name><trkseg>
    <trkpt lat="47.000" lon="-122.000"><ele>100</ele></trkpt>
    <trkpt lat="47.006" lon="-121.995"><ele>420</ele></trkpt>
    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>
  </trkseg></trk>
</gpx>`

test('two ways round the same leg are not chained into an out-and-back', () => {
  const joined = joinLegs(parseGpx(TWO_WAYS_FIRST_LEG).paths)
  assert.equal(joined.length, 2, 'three legs chain; the alternative stays separate')
  const main = joined.find(p => p.points.length > 3)!
  near(pathLength(main.points), 2275, 10, 'the three sequential legs, and only those')
  assert.equal(main.joins.length, 2, 'two junctions, not three')
})

test('an alternative first leg is reported as a choice at the start', () => {
  const m = buildRoute(parseGpx(TWO_WAYS_FIRST_LEG).paths, { stopNames: ['Hut A', 'Hut B'] })!
  assert.equal(m.main.name, 'Direct')
  assert.equal(m.stops.length, 2, 'the alternative did not invent a third stop')
  assert.equal(m.variants.length, 1)

  const alt = m.variants[0]
  assert.equal(alt.path.name, 'Long way')
  near(alt.branchAlong, 0, 5, 'the choice is made at the trailhead')
  near(alt.rejoinAlong!, 758.4, 5, 'and closes at the first hut')
  assert.ok(alt.deltaDistance > 0, 'the long way is longer')
  assert.ok(alt.deltaAscent > 0, 'and climbs more')
})

/** The same three legs, now with sights marked along them. */
const WITH_SIGHTS = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="47.000" lon="-121.9955"><ele>220</ele><name>Boczan viewpoint</name></wpt>
  <wpt lat="47.0012" lon="-121.985"><ele>480</ele><name>Zawrat</name></wpt>
  <wpt lat="48.500" lon="-120.000"><ele>900</ele><name>Somewhere else</name></wpt>
  <trk><name>Leg 1</name><trkseg>
    <trkpt lat="47.000" lon="-122.000"><ele>100</ele></trkpt>
    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>
  </trkseg></trk>
  <trk><name>Leg 2</name><trkseg>
    <trkpt lat="47.000" lon="-121.990"><ele>300</ele></trkpt>
    <trkpt lat="47.000" lon="-121.980"><ele>500</ele></trkpt>
  </trkseg></trk>
</gpx>`

test('sights are fixed to a position along the route', () => {
  const doc = parseGpx(WITH_SIGHTS)
  const m = buildRoute(doc.paths, { waypoints: doc.waypoints })!
  assert.deepEqual(m.waypoints.map(w => w.name), ['Boczan viewpoint', 'Zawrat'],
    'the one 160 km away is dropped')
  near(m.waypoints[0].along, 341, 10, 'projected onto the line, not snapped to a vertex')
  near(m.waypoints[1].along, 1137, 10)
  assert.ok(m.waypoints[0].offset < 5, 'this one sits on the trail')
  assert.ok(m.waypoints[1].offset > 100, 'and this one is off it, which is recorded not hidden')
  assert.deepEqual(m.waypoints.map(w => w.ele), [220, 480])
})

test('sights are not stops and cost no time', () => {
  const doc = parseGpx(WITH_SIGHTS)
  const withSights = buildRoute(doc.paths, { waypoints: doc.waypoints, restSeconds: 600 })!
  const without = buildRoute(doc.paths, { restSeconds: 600 })!
  assert.equal(withSights.stops.length, without.stops.length, 'sights do not become stops')
  const a = progressOn(withSights, withSights.main.points[0])!
  const b = progressOn(without, without.main.points[0])!
  assert.equal(a.remainingRest, b.remainingRest, 'and add no rest')
  assert.equal(a.remainingTotal, b.remainingTotal, 'so the finish estimate is unchanged')
})

test('nextWaypoint walks forward and then runs out', () => {
  const doc = parseGpx(WITH_SIGHTS)
  const m = buildRoute(doc.paths, { waypoints: doc.waypoints })!
  assert.equal(nextWaypoint(m, 0)?.name, 'Boczan viewpoint')
  assert.equal(nextWaypoint(m, 500)?.name, 'Zawrat')
  assert.equal(nextWaypoint(m, 2000), null)
})

test('a route with no waypoints carries an empty list, not undefined', () => {
  assert.deepEqual(buildRoute(parseGpx(SPLIT_LEGS).paths)!.waypoints, [])
  assert.equal(nextWaypoint(buildRoute(parseGpx(SPLIT_LEGS).paths)!, 0), null)
})

test('the waypoint radius is adjustable', () => {
  const doc = parseGpx(WITH_SIGHTS)
  assert.equal(buildRoute(doc.paths, { waypoints: doc.waypoints, waypointRadiusM: 50 })!.waypoints.length,
    1, 'a tight radius keeps only what is on the trail')
})
