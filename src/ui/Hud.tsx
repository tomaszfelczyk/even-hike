import { useEffect, useRef } from 'react'
import { renderProfile } from '../lib/profile.ts'
import type { HudView } from '../lib/hud.ts'

/** The glasses canvas. Everything here is laid out in these coordinates. */
const CANVAS_W = 576
const CANVAS_H = 288
const PROFILE_W = 288
const PROFILE_H = 96

/**
 * The glasses display, mirrored.
 *
 * Positioned in the glasses' own 576x288 coordinates and scaled to fit, so the
 * phone shows the real layout rather than a web approximation of it. If text
 * overflows a container here, it overflows there.
 */
export function Hud({ view }: { view: HudView }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return

    const bitmap = renderProfile(view.profile.points, {
      width: PROFILE_W,
      height: PROFILE_H,
      ...(view.profile.atMeters === undefined ? {} : { atMeters: view.profile.atMeters }),
      marks: view.profile.marks,
      minorMarks: view.profile.minorMarks,
    })

    const image = context.createImageData(bitmap.width, bitmap.height)
    for (let i = 0; i < bitmap.data.length; i++) {
      const value = bitmap.data[i]
      image.data[i * 4] = value
      image.data[i * 4 + 1] = value
      image.data[i * 4 + 2] = value
      image.data[i * 4 + 3] = 255
    }
    element.width = bitmap.width
    element.height = bitmap.height
    context.putImageData(image, 0, 0)
  }, [view])

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
        background: '#000',
        color: '#e8e8e8',
        borderRadius: 8,
        overflow: 'hidden',
        // One unit of the glasses canvas per container percent, so every child
        // can be placed in the coordinates the device actually uses.
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        containerType: 'inline-size',
      }}
    >
      <Region x={0} y={0} w={576} h={24}>
        <Line size={15} brightness={1}>{view.title}</Line>
      </Region>

      <Region x={0} y={28} w={PROFILE_W} h={PROFILE_H}>
        <canvas
          ref={canvas}
          style={{ width: '100%', height: '100%', imageRendering: 'pixelated', display: 'block' }}
        />
      </Region>

      <Region x={300} y={28} w={276} h={100}>
        <Line size={17} brightness={view.brightness}>{view.stats}</Line>
      </Region>

      <Region x={0} y={132} w={576} h={150}>
        <Line size={15} brightness={view.brightness}>{view.status}</Line>
      </Region>
    </div>
  )
}

/** A container placed in glasses coordinates. */
function Region(
  { x, y, w, h, children }:
  { x: number; y: number; w: number; h: number; children: React.ReactNode },
) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${(x / CANVAS_W) * 100}%`,
        top: `${(y / CANVAS_H) * 100}%`,
        width: `${(w / CANVAS_W) * 100}%`,
        height: `${(h / CANVAS_H) * 100}%`,
      }}
    >
      {children}
    </div>
  )
}

/**
 * Text at a size expressed in glasses pixels, scaled with the container.
 * `brightness` mirrors the firmware's 0..4 text levels.
 */
function Line(
  { size, brightness = 4, children }:
  { size: number; brightness?: number; children: React.ReactNode },
) {
  return (
    <pre
      style={{
        margin: 0,
        opacity: 0.25 + 0.75 * (Math.max(0, Math.min(4, brightness)) / 4),
        fontSize: `${(size / CANVAS_W) * 100}cqw`,
        lineHeight: 1.25,
        whiteSpace: 'pre-wrap',
        overflow: 'hidden',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </pre>
  )
}
