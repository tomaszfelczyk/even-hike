import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeRest, endRest, parseRests, restDurationMs, serializeRests, startRest,
  toggleRest, totalRestMs, type Rest,
} from './rests.ts'

const T0 = 1_757_000_000_000
const place = { along: 4630, lat: 49.24327, lon: 20.00693, ele: 1512, at: 'Murowaniec' }

test('a rest starts open and closes on the second gesture', () => {
  const started = toggleRest([], place, T0)
  assert.equal(started.length, 1)
  assert.equal(started[0].endedAt, null, 'still resting')
  assert.equal(activeRest(started)?.at, 'Murowaniec')

  const ended = toggleRest(started, place, T0 + 12 * 60_000)
  assert.equal(ended.length, 1, 'the same rest, not a second one')
  assert.equal(ended[0].endedAt, T0 + 12 * 60_000)
  assert.equal(activeRest(ended), null)
  assert.equal(restDurationMs(ended[0], T0), 12 * 60_000)
})

test('total counts a rest that is still running', () => {
  const resting = startRest([], place, T0)
  assert.equal(totalRestMs(resting, T0 + 5 * 60_000), 5 * 60_000, 'counts up live')

  const done = endRest(resting, T0 + 5 * 60_000)
  assert.equal(totalRestMs(done, T0 + 99 * 60_000), 5 * 60_000, 'and stops once ended')
})

test('starting a second rest closes an abandoned one', () => {
  // The app died, or the walker forgot to end it and rested again later.
  const first = startRest([], place, T0)
  const second = startRest(first, { ...place, along: 12570, at: 'PTTK Piec Stawow' }, T0 + 3600_000)
  assert.equal(second.length, 2)
  assert.equal(second[0].endedAt, T0 + 3600_000, 'the stale one is closed where it stood')
  assert.equal(activeRest(second)?.at, 'PTTK Piec Stawow', 'only one is ever open')
})

test('ending with nothing running is a no-op, not a crash', () => {
  assert.deepEqual(endRest([], T0), [])
  const done = endRest(startRest([], place, T0), T0 + 60_000)
  assert.deepEqual(endRest(done, T0 + 120_000), done, 'and does not reopen or re-end')
})

test('a clock that jumps backwards cannot produce negative rest', () => {
  const done = endRest(startRest([], place, T0), T0 - 60_000)
  assert.ok(restDurationMs(done[0], T0) >= 0)
  assert.ok(totalRestMs(done, T0) >= 0)
})

test('the log round-trips through storage', () => {
  const log = endRest(startRest([], place, T0), T0 + 600_000)
  const back = parseRests(serializeRests(log))
  assert.deepEqual(back, log)
})

test('a corrupt or empty store yields an empty log rather than throwing', () => {
  // getLocalStorage returns '' for a key that was never written.
  assert.deepEqual(parseRests(''), [])
  assert.deepEqual(parseRests('{"not":"an array"}'), [])
  assert.deepEqual(parseRests('[[[garbage'), [])
})

test('malformed entries are dropped, the rest of the log survives', () => {
  const good: Rest = { startedAt: T0, endedAt: T0 + 60_000, along: 100, lat: 49, lon: 20 }
  const source = JSON.stringify([
    good,
    { startedAt: 'nope', along: 1, lat: 49, lon: 20 },
    { startedAt: T0, along: 1 },
    null,
    { startedAt: T0 + 5, endedAt: null, along: 2, lat: 49, lon: 20 },
  ])
  const parsed = parseRests(source)
  assert.equal(parsed.length, 2, 'two valid entries kept')
  assert.deepEqual(parsed[0], good)
  assert.equal(parsed[1].endedAt, null, 'an open rest survives a reload mid-rest')
})

test('a reloaded log comes back in time order', () => {
  const parsed = parseRests(JSON.stringify([
    { startedAt: T0 + 1000, endedAt: null, along: 2, lat: 49, lon: 20 },
    { startedAt: T0, endedAt: T0 + 10, along: 1, lat: 49, lon: 20 },
  ]))
  assert.deepEqual(parsed.map(r => r.startedAt), [T0, T0 + 1000])
  assert.equal(activeRest(parsed)?.along, 2, 'and the open one is still the active one')
})
