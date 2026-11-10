import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { CROP_HANDLES, dragCrop, type CropHandle, type CropRect } from '../domain'

interface Props {
  /** The preview canvas, showing the whole image while cropping. */
  canvasRef: RefObject<HTMLCanvasElement | null>
  imageWidth: number
  imageHeight: number
  rect: CropRect
  onChange: (rect: CropRect) => void
  onApply: () => void
  onCancel: () => void
}

const HANDLE_LABEL: Record<CropHandle, string> = {
  move: 'Move crop area',
  nw: 'Resize crop from top-left corner',
  n: 'Resize crop from top edge',
  ne: 'Resize crop from top-right corner',
  e: 'Resize crop from right edge',
  se: 'Resize crop from bottom-right corner',
  s: 'Resize crop from bottom edge',
  sw: 'Resize crop from bottom-left corner',
  w: 'Resize crop from left edge',
}

/**
 * FR-20 crop rectangle over the preview: drag the body to move it, drag any of the eight handles to resize it.
 * Everything is clamped to the image and to the 16 × 16 minimum by `dragCrop`. Arrow keys move the focused body or
 * handle by one screen pixel (Shift: ten); Enter applies, Escape cancels.
 */
export function CropOverlay({ canvasRef, imageWidth: W, imageHeight: H, rect, onChange, onApply, onCancel }: Props) {
  // Canvas content box relative to the preview figure; tracked so the overlay follows layout changes.
  const [box, setBox] = useState({ left: 0, top: 0, k: 1 })
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const measure = () => {
      const k = Math.min(canvas.offsetWidth / W, canvas.offsetHeight / H) || 1
      setBox({
        left: canvas.offsetLeft + (canvas.offsetWidth - W * k) / 2,
        top: canvas.offsetTop + (canvas.offsetHeight - H * k) / 2,
        k,
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [canvasRef, W, H])

  const drag = useRef<{ handle: CropHandle; start: CropRect; x: number; y: number } | null>(null)
  // NFR-12: the Crop button that opened this overlay is gone, so take focus; arrows, Enter and Escape work at once.
  const rectRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body) rectRef.current?.focus({ preventScroll: true })
  }, [])
  const latest = useRef({ rect, onChange })
  latest.current = { rect, onChange }

  const onPointerDown = (handle: CropHandle) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.currentTarget.focus()
    drag.current = { handle, start: latest.current.rect, x: e.clientX, y: e.clientY }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const next = dragCrop(d.start, d.handle, (e.clientX - d.x) / box.k, (e.clientY - d.y) / box.k, W, H)
    latest.current.onChange(next)
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const onKeyDown = (handle: CropHandle) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onApply()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
    if (!dir) return
    e.preventDefault()
    e.stopPropagation()
    const step = Math.max(1, Math.round(1 / box.k)) * (e.shiftKey ? 10 : 1)
    onChange(dragCrop(rect, handle, dir[0] * step, dir[1] * step, W, H))
  }

  const pos = {
    left: box.left + rect.x * box.k,
    top: box.top + rect.y * box.k,
    width: rect.width * box.k,
    height: rect.height * box.k,
  }

  return (
    <div className="crop-layer" data-testid="crop-overlay">
      <div
        ref={rectRef}
        className="crop-rect"
        style={pos}
        tabIndex={0}
        role="group"
        aria-label={`${HANDLE_LABEL.move}: ${rect.width} × ${rect.height} px at ${rect.x}, ${rect.y}`}
        data-testid="crop-rect"
        onPointerDown={onPointerDown('move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown('move')}
      >
        <span className="crop-grid" aria-hidden="true" />
        {CROP_HANDLES.map((h) => (
          <button
            key={h}
            type="button"
            className={`crop-handle crop-handle-${h}`}
            aria-label={HANDLE_LABEL[h]}
            data-handle={h}
            onPointerDown={onPointerDown(h)} // move/up bubble to the body handlers below
            onKeyDown={onKeyDown(h)}
          />
        ))}
      </div>
    </div>
  )
}
