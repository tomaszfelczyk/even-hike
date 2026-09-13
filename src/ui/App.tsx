import { useMemo, useSyncExternalStore } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, Divider, Text } from '@jappyjan/even-realities-ui'
import { ROUTES } from '../routes.ts'
import { modelFor } from '../build-route.ts'
import { getState, setState, subscribe } from '../store.ts'
import { segmentsOf } from '../lib/route.ts'
import { hikingTime } from '../lib/geo.ts'
import { totalRestMs } from '../lib/rests.ts'
import { ElevationProfile } from './ElevationProfile.tsx'

const km = (metres: number) => `${(metres / 1000).toFixed(1)} km`
const hhmm = (seconds: number) => {
  const total = Math.round(seconds / 60)
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}`
}

const GLASSES_LABEL = {
  connecting: 'Connecting to glasses…',
  ready: 'Glasses connected',
  unavailable: 'No glasses — browser preview',
  failed: 'Glasses connection failed',
} as const

export function App() {
  const state = useSyncExternalStore(subscribe, getState)

  // Parsing every route is ~7 ms each, but there is no reason to redo it on
  // each render.
  const models = useMemo(
    () => new Map(ROUTES.map(route => [route.id, modelFor(route)])),
    [],
  )

  const restedMs = totalRestMs(state.rests, Date.now())

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16, display: 'grid', gap: 16 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <Text as="h1" variant="title-lg">Even Hike</Text>
        <Badge>{GLASSES_LABEL[state.glasses]}</Badge>
      </header>

      {restedMs > 0 && (
        <Text variant="detail">
          {Math.round(restedMs / 60_000)} min rested on this route
        </Text>
      )}

      {ROUTES.map(route => {
        const model = models.get(route.id)!
        const segments = segmentsOf(model)
        const active = route.id === state.routeId

        return (
          <Card key={route.id} style={active ? { outline: '2px solid currentColor' } : undefined}>
            <CardHeader style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <Text as="h2" variant="title-2">{route.name}</Text>
              {active
                ? <Badge>{state.glasses === 'ready' ? 'On glasses' : 'Selected'}</Badge>
                : (
                  <Button size="sm" onClick={() => setState({ routeId: route.id })}>
                    {state.glasses === 'ready' ? 'Send to glasses' : 'Select'}
                  </Button>
                )}
            </CardHeader>

            <CardContent style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                <Stat label="Distance" value={km(model.mainLength)} />
                <Stat label="Climb" value={`${model.mainAscent.toFixed(0)} m`} />
                <Stat label="Walking" value={hhmm(hikingTime(model.main.points))} />
                <Stat label="Segments" value={String(segments.length)} />
              </div>

              <ElevationProfile model={model} />

              <Divider />

              <div style={{ display: 'grid', gap: 4 }}>
                {segments.map(segment => (
                  <Text key={`${segment.fromAlong}-${segment.toAlong}`} variant="detail">
                    {segment.from} → {segment.to} · {km(segment.distance)} · ↑{segment.ascent.toFixed(0)} m · {hhmm(segment.time)}
                  </Text>
                ))}
              </div>

              {model.variants.length > 0 && (
                <div style={{ display: 'grid', gap: 4 }}>
                  {model.variants.map(variant => (
                    <Text key={`${variant.path.name}-${variant.branchAlong}`} variant="detail">
                      Alternative at {km(variant.branchAlong)}: {variant.path.name} ·{' '}
                      {variant.deltaDistance >= 0 ? '+' : '−'}{km(Math.abs(variant.deltaDistance))} ·{' '}
                      {variant.deltaAscent >= 0 ? '+' : '−'}{Math.abs(variant.deltaAscent).toFixed(0)} m
                    </Text>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </main>
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
