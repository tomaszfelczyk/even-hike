import { useEffect, useState } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, Divider, Text } from '@jappyjan/even-realities-ui'
import { store } from '../storage.ts'
import {
  deleteSession, elapsedMs, loadSessions, movingMs, walkedDistance, type HikeSession,
} from '../lib/history.ts'
import { restDurationMs, totalRestMs } from '../lib/rests.ts'

const hhmm = (ms: number) => {
  const total = Math.round(ms / 60_000)
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`
}
const km = (metres: number) => `${(metres / 1000).toFixed(1)} km`

/**
 * Recorded hikes.
 *
 * Reloads whenever `refreshKey` changes, which is how a hike finished on the
 * glasses shows up here without polling storage.
 */
export function History({ refreshKey }: { refreshKey: unknown }) {
  const [sessions, setSessions] = useState<HikeSession[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void loadSessions(store).then(loaded => { if (live) setSessions(loaded) })
    return () => { live = false }
  }, [refreshKey])

  async function remove(id: string): Promise<void> {
    setBusy(id)
    await deleteSession(store, id)
    setSessions(await loadSessions(store))
    setBusy(null)
  }

  if (sessions === null) return null
  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader><Text as="h2" variant="title-2">History</Text></CardHeader>
        <CardContent>
          <Text variant="detail">
            No hikes recorded yet. One starts on the first GPS fix near a route and is
            written out as you walk.
          </Text>
        </CardContent>
      </Card>
    )
  }

  const now = Date.now()

  return (
    <Card>
      <CardHeader style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text as="h2" variant="title-2">History</Text>
        <Text variant="detail">{sessions.length} recorded</Text>
      </CardHeader>
      <CardContent style={{ display: 'grid', gap: 16 }}>
        {sessions.map((session, index) => {
          const rested = totalRestMs(session.rests, now)
          return (
            <div key={session.id} style={{ display: 'grid', gap: 6 }}>
              {index > 0 && <Divider />}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <Text variant="title-2">{session.routeName || 'Unnamed route'}</Text>
                {session.endedAt === null
                  ? <Badge>In progress</Badge>
                  : <Text variant="detail">{new Date(session.startedAt).toLocaleString()}</Text>}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                <Stat label="Walked" value={km(walkedDistance(session))} />
                <Stat label="Elapsed" value={hhmm(elapsedMs(session, now))} />
                <Stat label="Moving" value={hhmm(movingMs(session, now))} />
                <Stat label="Rested" value={hhmm(rested)} />
                <Stat label="Trace" value={`${session.track.length} pts`} />
              </div>

              {session.rests.length > 0 && (
                <div style={{ display: 'grid', gap: 2 }}>
                  {session.rests.map(rest => (
                    <Text key={rest.startedAt} variant="detail">
                      {rest.at ?? `${(rest.along / 1000).toFixed(1)} km`}
                      {rest.ele === undefined ? '' : ` · ${rest.ele.toFixed(0)} m`}
                      {' · '}{Math.round(restDurationMs(rest, now) / 60_000)} min
                      {rest.endedAt === null ? ' (still resting)' : ''}
                    </Text>
                  ))}
                </div>
              )}

              <div>
                <Button size="sm" variant="negative" disabled={busy !== null} onClick={() => void remove(session.id)}>
                  {busy === session.id ? 'Deleting…' : 'Delete'}
                </Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <Text variant="title-2">{value}</Text>
      <Text variant="detail">{label}</Text>
    </div>
  )
}
