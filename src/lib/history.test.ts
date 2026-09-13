import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteSession, elapsedMs, endSession, loadSessions, movingMs, parseSession,
  recordFix, resumableSession, saveSession, serializeSession, startSession,
  walkedDistance, type HikeSession,
} from './history.ts'
import { startRest, endRest } from './rests.ts'
import type { KeyValueStore } from './route-store.ts'

const T0 = 1_757_000_000_000
const memoryStore = (): KeyValueStore & { raw: Map<string, string> } => {
  const raw = new Map<string, string>()
  return { raw, get: async k => raw.get(k) ?? '', set: async (k, v) => { raw.set(k, v) } }
}

/** ~11 m apart at this latitude. */
const at = (i: number) => ({ lat: 49.24 + i * 0.0001, lon: 20.0 })

test('fixes closer together than the spacing are dropped', () => {
  let session = startSession('tatry', 'Tatry', T0)
  for (let i = 0; i < 20; i++) session = recordFix(session, at(i))
  // 20 fixes ~11 m apart across ~210 m, kept at 25 m spacing.
  assert.ok(session.track.length < 12, `kept ${session.track.length} of 20`)
  assert.ok(session.track.length > 5, 'but the shape is still there')
})

test('a fix that adds nothing returns the same object', () => {
  const session = recordFix(startSession('t', 'T', T0), at(0))
  const again = recordFix(session, at(0))
  assert.equal(again, session, 'identity lets the caller skip a write')
})

test('walked distance comes from the trace, not the plan', () => {
  let session = startSession('t', 'T', T0)
  for (let i = 0; i < 100; i++) session = recordFix(session, at(i))
  const walked = walkedDistance(session)
  assert.ok(walked > 1000 && walked < 1200, `~1.1 km expected, got ${walked.toFixed(0)}`)
})

test('elapsed includes rest, moving does not', () => {
  let session = startSession('t', 'T', T0)
  session = { ...session, rests: endRest(startRest([], { along: 0, lat: 49, lon: 20 }, T0), T0 + 1_200_000) }
  session = endSession(session, T0 + 3_600_000)

  assert.equal(elapsedMs(session, T0), 3_600_000, 'an hour on the hill')
  assert.equal(movingMs(session, T0), 2_400_000, 'twenty minutes of which was sitting down')
})

test('ending is idempotent and cannot run backwards', () => {
  const done = endSession(startSession('t', 'T', T0), T0 + 1000)
  assert.equal(endSession(done, T0 + 9999).endedAt, T0 + 1000, 'the first ending stands')
  assert.equal(endSession(startSession('t', 'T', T0), T0 - 5000).endedAt, T0, 'never before it began')
})

test('a session round-trips through storage with its trace and rests', async () => {
  const store = memoryStore()
  let session = startSession('tatry', 'Tatry', T0)
  for (let i = 0; i < 50; i++) session = recordFix(session, { ...at(i), }, { ele: 1000 + i })
  session = { ...session, rests: endRest(startRest([], { along: 500, lat: 49.24, lon: 20, at: 'Murowaniec' }, T0), T0 + 600_000) }
  session = endSession(session, T0 + 3_600_000)

  await saveSession(store, session)
  const [back] = await loadSessions(store)
  assert.equal(back.id, session.id)
  assert.equal(back.routeName, 'Tatry')
  assert.equal(back.endedAt, T0 + 3_600_000)
  assert.equal(back.track.length, session.track.length)
  assert.equal(back.rests.length, 1)
  assert.equal(back.rests[0].at, 'Murowaniec')
  assert.ok(Math.abs(walkedDistance(back) - walkedDistance(session)) < 5, 'trace survives encoding')
})

test('a recorded hike is a fraction of the route it followed', async () => {
  const store = memoryStore()
  let session = startSession('tatry', 'Tatry', T0)
  // A 20 km walk at 25 m spacing is about 800 points.
  for (let i = 0; i < 800; i++) session = recordFix(session, { lat: 49.24 + i * 0.00025, lon: 20.0 }, { ele: 1000 })
  await saveSession(store, session)
  const bytes = Buffer.byteLength(store.raw.get(`hike:${session.id}`)!)
  assert.ok(bytes < 12_000, `${(bytes / 1024).toFixed(1)} KB for a full day's walk`)
})

test('history is newest first and deletable', async () => {
  const store = memoryStore()
  await saveSession(store, startSession('a', 'A', T0))
  await saveSession(store, startSession('b', 'B', T0 + 86_400_000))
  assert.deepEqual((await loadSessions(store)).map(s => s.routeName), ['B', 'A'])

  await deleteSession(store, sessionOf('b', T0 + 86_400_000))
  assert.deepEqual((await loadSessions(store)).map(s => s.routeName), ['A'])
  assert.equal(store.raw.get(`hike:${sessionOf('b', T0 + 86_400_000)}`), '')
})
const sessionOf = (routeId: string, startedAt: number) => `${routeId}-${startedAt}`

test('an unreadable hike does not hide the others', async () => {
  const store = memoryStore()
  await saveSession(store, startSession('a', 'A', T0))
  await saveSession(store, startSession('b', 'B', T0 + 1000))
  store.raw.set(`hike:${sessionOf('b', T0 + 1000)}`, '{"id":')
  assert.deepEqual((await loadSessions(store)).map(s => s.routeName), ['A'])
  assert.equal(parseSession(''), null, 'an unwritten key reads as empty string')
})

test('an unfinished hike resumes, an abandoned one does not', async () => {
  const store = memoryStore()
  const now = Date.now()
  await saveSession(store, { ...startSession('tatry', 'Tatry', now - 3_600_000) })
  assert.equal((await resumableSession(store, 'tatry'))?.routeId, 'tatry', 'still under way')
  assert.equal(await resumableSession(store, 'other'), null, 'a different route')

  const stale = memoryStore()
  await saveSession(stale, startSession('tatry', 'Tatry', now - 40 * 24 * 3_600_000))
  assert.equal(await resumableSession(stale, 'tatry'), null, 'last month is abandoned, not in progress')
})

test('a finished hike is never resumed', async () => {
  const store = memoryStore()
  await saveSession(store, endSession(startSession('tatry', 'Tatry', Date.now() - 1000), Date.now()))
  assert.equal(await resumableSession(store, 'tatry'), null)
})

test('serializeSession keeps the payload flat and stringy', () => {
  const session: HikeSession = startSession('t', 'T', T0)
  const raw = JSON.parse(serializeSession(session))
  assert.equal(typeof raw.track, 'string', 'the trace is encoded, not an array of objects')
  assert.equal(typeof raw.rests, 'string')
})
