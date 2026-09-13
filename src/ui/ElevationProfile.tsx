import { useEffect, useRef } from 'react'
import { renderProfile } from '../lib/profile.ts'
import type { RouteModel } from '../lib/route.ts'

/**
 * The same bitmap the glasses receive, drawn to a canvas.
 *
 * Deliberately not a prettier web chart: what the phone shows should be what
 * is actually on the glasses, so a layout problem is visible here first.
 */
export function ElevationProfile({ model, scale = 2 }: { model: RouteModel; scale?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return

    const bitmap = renderProfile(model.main.points, {
      width: 288,
      height: 144,
      marks: model.stops.map(stop => stop.along),
      minorMarks: model.waypoints.map(waypoint => waypoint.along),
    })

    // Grey levels to RGBA. The firmware quantises to four levels; this shows
    // the unquantised bitmap, so fine gradations here may flatten on device.
    const image = context.createImageData(bitmap.width, bitmap.height)
    for (let i = 0; i < bitmap.data.length; i++) {
      const value = bitmap.data[i]
      image.data[i * 4] = value
      image.data[i * 4 + 1] = value
      image.data[i * 4 + 2] = value
      image.data[i * 4 + 3] = 255
    }

    const source = document.createElement('canvas')
    source.width = bitmap.width
    source.height = bitmap.height
    source.getContext('2d')?.putImageData(image, 0, 0)

    element.width = bitmap.width * scale
    element.height = bitmap.height * scale
    context.imageSmoothingEnabled = false
    context.drawImage(source, 0, 0, element.width, element.height)
  }, [model, scale])

  return <canvas ref={canvas} style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 8 }} />
}
