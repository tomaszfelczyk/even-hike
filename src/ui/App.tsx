import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, Divider, Text } from '@jappyjan/even-realities-ui'
import { BUILT_IN_ROUTES } from '../routes.ts'
import { modelFor } from '../build-route.ts'
import { store } from '../storage.ts'
import { getState, setState, subscribe } from '../store.ts'
import { segmentsOf } from '../lib/route.ts'
import { hikingTime } from '../lib/geo.ts'
import { totalRestMs } from '../lib/rests.ts'
import { parseGpx } from '../lib/gpx.ts'
import {
  deleteRoute, loadRoutes, routeIdFor, saveRoute, type RouteRecord,
} from '../lib/route-store.ts'
import { findSameRoute, mergeAsVariants } from '../lib/merge.ts'
import { ElevationProfile } from './ElevationProfile.tsx'
import { Hud } from './Hud.tsx'
import { History } from './History.tsx'
import { hudView } from '../lib/hud.ts'
import { follow } from '../lib/follow.ts'
import { displayTitle } from '../lib/route.ts'

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

/** Merge saved routes in behind the built-ins, replacing any with the same id. */
async function refreshRoutes(): Promise<void> {
  const saved = await loadRoutes(store)
  const byId = new Map(BUILT_IN_ROUTES.map(route => [route.id, route]))
  for (const route of saved) byId.set(route.id, route)
  setState({ routes: [...byId.values()] })
}

export function App() {
  const state = useSyncExternalStore(subscribe, getState)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => { void refreshRoutes() }, [])

  // Parsing is a few milliseconds per route; no reason to redo it every render.
  const models = useMemo(
    () => new Map(state.routes.map(route => [route.id, modelFor(route)])),
    [state.routes],
  )

  async function importGpx(file: File, replacing?: RouteRecord): Promise<void> {
    setBusy(replacing?.id ?? 'new')
    setError(null)
    setNotice(null)
    try {
      const doc = parseGpx(await file.text())
      if (doc.paths.length === 0) throw new Error('no tracks or routes in that file')

      const fallbackName = doc.paths[0].name || file.name.replace(/\.gpx$/i, '')

      // Same ends and same stops means this is another way round a walk we
      // already have. Merging keeps the choice on the glasses at the junction
      // rather than hiding it in the route picker.
      if (replacing === undefined) {
        const sibling = findSameRoute(state.routes, doc.paths)
        if (sibling !== null) {
          const { route, added } = mergeAsVariants(sibling, doc.paths, fallbackName)
          if (added.length === 0) {
            setNotice(`Already part of "${sibling.name}" — nothing new in that file`)
          } else {
            await saveRoute(store, route)
            await refreshRoutes()
            setState({ routeId: route.id })
            setNotice(`Added ${added.join(', ')} to "${sibling.name}" as an alternative`)
          }
          return
        }
      }

      const name = replacing?.name ?? fallbackName
      const record: RouteRecord = {
        id: replacing?.id ?? routeIdFor(name, state.routes.map(r => r.id)),
        name,
        paths: doc.paths,
        waypoints: doc.waypoints,
        // Keep the annotations when swapping the geometry: stop names and rest
        // are the part that is not in the file.
        ...(replacing?.stopNames === undefined ? {} : { stopNames: replacing.stopNames }),
        ...(replacing?.restSeconds === undefined ? {} : { restSeconds: replacing.restSeconds }),
        updatedAt: Date.now(),
      }
      if (modelFor(record) === null) throw new Error('those tracks are too short to navigate')

      await saveRoute(store, record)
      await refreshRoutes()
      setState({ routeId: record.id })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function remove(route: RouteRecord): Promise<void> {
    setBusy(route.id)
    await deleteRoute(store, route.id)
    await refreshRoutes()
    if (getState().routeId === route.id) {
      setState({ routeId: getState().routes[0]?.id ?? BUILT_IN_ROUTES[0].id })
    }
    setBusy(null)
  }

  const restedMs = totalRestMs(state.rests, Date.now())

  // The live HUD, from the same function the glasses render through. Without a
  // fix there is nothing to follow, so the mirror sits at the route's start —
  // which is also what makes it useful in a browser with no hardware.
  const activeModel = models.get(state.routeId) ?? null
  const hud = activeModel === null ? null : hudView({
    model: activeModel,
    routeName: displayTitle(state.routes.find(r => r.id === state.routeId)?.name ?? ''),
    segments: segmentsOf(activeModel),
    view: state.view,
    following: state.following ?? follow(activeModel, activeModel.main.points[0], null),
    awayM: state.awayM,
    rests: state.rests,
    liveGps: state.liveGps,
    notice: state.notice,
    now: Date.now(),
  })

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16, display: 'grid', gap: 16 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <Text as="h1" variant="title-lg">Even Hike</Text>
        <Badge>{GLASSES_LABEL[state.glasses]}</Badge>
      </header>

      <GpxButton
        label={busy === 'new' ? 'Importing…' : 'Import GPX'}
        disabled={busy !== null}
        onFile={file => void importGpx(file)}
      />
      {error !== null && <Text variant="detail" style={{ color: 'crimson' }}>{error}</Text>}
      {notice !== null && <Text variant="detail">{notice}</Text>}

      {/* Reloads when the rests change, which is the signal a hike advanced. */}
      <History refreshKey={state.rests.length + (state.following === null ? 0 : 1)} />

      {hud !== null && (
        <Card>
          <CardHeader style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text as="h2" variant="title-2">On the glasses</Text>
            <Text variant="detail">576 x 288</Text>
          </CardHeader>
          <CardContent>
            <Hud view={hud} />
          </CardContent>
        </Card>
      )}
      {restedMs > 0 && (
        <Text variant="detail">{Math.round(restedMs / 60_000)} min rested on this route</Text>
      )}

      {state.routes.map(route => {
        const model = models.get(route.id)
        if (!model) return null
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
                {model.variants.map(variant => (
                  <Text key={`${variant.path.name}-${variant.branchAlong}`} variant="detail">
                    Alternative at {km(variant.branchAlong)}: {variant.path.name} ·{' '}
                    {variant.deltaDistance >= 0 ? '+' : '−'}{km(Math.abs(variant.deltaDistance))} ·{' '}
                    {variant.deltaAscent >= 0 ? '+' : '−'}{Math.abs(variant.deltaAscent).toFixed(0)} m
                  </Text>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <GpxButton
                  label={busy === route.id ? 'Working…' : 'Replace GPX'}
                  disabled={busy !== null}
                  size="sm"
                  onFile={file => void importGpx(file, route)}
                />
                {route.builtIn
                  ? <Text variant="detail">Built in — replace to override, cannot be deleted</Text>
                  : (
                    <Button size="sm" variant="negative" disabled={busy !== null} onClick={() => void remove(route)}>
                      Delete
                    </Button>
                  )}
                {route.updatedAt !== undefined && route.updatedAt > 0 && (
                  <Text variant="detail">Imported {new Date(route.updatedAt).toLocaleDateString()}</Text>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </main>
  )
}

/** A file input behind a styled button; the raw input is unusable as a control. */
function GpxButton(
  { label, onFile, disabled, size = 'md' }:
  { label: string; onFile: (file: File) => void; disabled?: boolean; size?: 'sm' | 'md' },
) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".gpx,application/gpx+xml,text/xml"
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0]
          // Reset so choosing the same file twice still fires a change.
          event.target.value = ''
          if (file) onFile(file)
        }}
      />
      <Button size={size} disabled={disabled} onClick={() => input.current?.click()}>{label}</Button>
    </>
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
