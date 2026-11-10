import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { EDGE_VALUE_DEFAULT, type BackgroundSelection, type BrushStroke, type CropRect, type CutoutResult, type EditState, type SourceImage } from '../domain'
import { MaskEditor, unionRect, type Rect } from '../matte/applyEdits'
import { createEdgeService, type EdgeService } from '../matte/edgeService'
import { canvas2d } from '../matte/remove'
import { backgroundLayer, compositeCutout } from '../composite/background'
import { CropOverlay } from './CropOverlay'

interface Props {
  image: SourceImage
  cutout: CutoutResult
  edit: EditState
  /** FR-24/FR-25: layer composited behind the cutout; Transparent leaves the preview's alpha untouched. */
  background?: BackgroundSelection
  /** Called once per finished stroke, in image pixels. */
  onStroke: (stroke: BrushStroke) => void
  /** Crop being edited (FR-20). While set, the whole image is shown under the crop rectangle and painting is off. */
  cropDraft?: CropRect | null
  onCropDraftChange?: (rect: CropRect) => void
  onCropApply?: () => void
  onCropCancel?: () => void
}

/** Longest side of the on-screen preview; edits are always applied to the full-resolution mask. */
export const PREVIEW_MAX = 1600

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

interface Engine {
  editor: MaskEditor
  /** Full-resolution cutout canvas, updated by dirty rect only. */
  work: OffscreenCanvas | HTMLCanvasElement
  workCtx: Canvas2D
  imageData: ImageData
  /** Off-main-thread edge transform of this cutout's matte (FR-19). */
  edges: EdgeService
  /** Last edge value requested from `edges`. */
  requested: number
  requestedAt: number
  /** An edge result that arrived during a brush stroke; applied on pointer-up. */
  pending: { value: number; mask: Uint8ClampedArray } | null
}

/**
 * Editor preview with live erase/restore painting (FR-17, FR-18, NFR-10). Pointer input is mapped to image pixels,
 * stamped straight into the full-resolution mask, and only the touched region is re-uploaded and re-drawn on the next
 * animation frame. A circle shows the brush footprint at its true on-screen size.
 */
export function EditCanvas({ image, cutout, edit, background, onStroke, cropDraft = null, onCropDraftChange, onCropApply, onCropCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const engine = useRef<Engine | null>(null)
  const view = useRef<{ src: Rect; scale: number }>({ src: { x: 0, y: 0, width: 1, height: 1 }, scale: 1 })
  const live = useRef<BrushStroke | null>(null)
  /** Background at preview size, or null when nothing is drawn behind the cutout. */
  const bgLayer = useRef<OffscreenCanvas | HTMLCanvasElement | null>(null)
  const pending = useRef<{ dirty: Rect | null; since: number; frame: number }>({ dirty: null, since: 0, frame: 0 })
  const latest = useRef({ edit, onStroke })
  latest.current = { edit, onStroke }
  const cropping = cropDraft !== null
  const crop: CropRect | null = cropping ? null : edit.crop

  /** Copy `rect` (image pixels) from the work canvas to the preview, aligned to whole preview pixels. */
  const drawRegion = (rect: Rect | null) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const eng = engine.current
    if (!canvas || !ctx) return
    const { src, scale } = view.current
    if (!eng) {
      // No pixel access (e.g. canvas too large): show the auto-removal result without live editing.
      compositeCutout(ctx, cutout.cutoutBitmap, src, { x: 0, y: 0, width: canvas.width, height: canvas.height }, bgLayer.current)
      return
    }
    const r = rect ?? src
    const dx0 = Math.max(0, Math.floor((r.x - src.x) * scale) - 1)
    const dy0 = Math.max(0, Math.floor((r.y - src.y) * scale) - 1)
    const dx1 = Math.min(canvas.width, Math.ceil((r.x + r.width - src.x) * scale) + 1)
    const dy1 = Math.min(canvas.height, Math.ceil((r.y + r.height - src.y) * scale) + 1)
    if (dx1 <= dx0 || dy1 <= dy0) return
    const w = dx1 - dx0
    const h = dy1 - dy0
    // Same compositing step as the export (FR-29), restricted to the dirty region.
    const from = { x: src.x + dx0 / scale, y: src.y + dy0 / scale, width: w / scale, height: h / scale }
    compositeCutout(ctx, eng.work, from, { x: dx0, y: dy0, width: w, height: h }, bgLayer.current)
  }

  /** Upload the dirty region to the work canvas and draw it on the next frame (coalesces bursts of pointer events). */
  const schedule = (dirty: Rect | null, eventTime = performance.now()) => {
    if (!dirty) return
    const p = pending.current
    if (!p.dirty) p.since = eventTime
    p.dirty = unionRect(p.dirty, dirty)
    if (p.frame) return
    p.frame = requestAnimationFrame(() => {
      p.frame = 0
      const eng = engine.current
      const d = p.dirty
      p.dirty = null
      if (!eng || !d) return
      eng.workCtx.putImageData(eng.imageData, 0, 0, d.x, d.y, d.width, d.height)
      drawRegion(d)
      // Pointer-to-preview latency of the oldest event in this frame (NFR-10), for diagnostics and checks.
      canvasRef.current?.setAttribute('data-brush-latency', String(Math.round(performance.now() - p.since)))
    })
  }

  // Build the full-resolution editor for this image + cutout (again when the full model replaces the tiny one).
  useEffect(() => {
    const { width: W, height: H } = image
    live.current = null
    try {
      const { ctx: readCtx } = canvas2d(W, H, { willReadFrequently: true })
      readCtx.drawImage(image.decodedBitmap, 0, 0)
      // Start from the model matte; a non-default edge value is computed off-thread and swapped in.
      const editor = new MaskEditor(W, H, readCtx.getImageData(0, 0, W, H).data, cutout.alphaMask)
      editor.sync(latest.current.edit.strokes)
      const { canvas: work, ctx: workCtx } = canvas2d(W, H) // GPU-backed: dirty-rect uploads stay cheap
      const imageData = new ImageData(editor.pixels, W, H)
      workCtx.putImageData(imageData, 0, 0)
      const eng: Engine = { editor, work, workCtx, imageData, edges: null!, requested: EDGE_VALUE_DEFAULT, requestedAt: 0, pending: null }
      eng.edges = createEdgeService(cutout.alphaMask, W, H, (value, mask) => {
        if (engine.current !== eng) return
        if (live.current) eng.pending = { value, mask }
        else applyEdgeResult(eng, mask)
      })
      engine.current = eng
      requestEdge()
    } catch {
      engine.current = null
    }
    drawRegion(null)
    const p = pending.current
    return () => {
      cancelAnimationFrame(p.frame)
      p.frame = 0
      p.dirty = null
      engine.current?.edges.dispose()
      engine.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, cutout])

  // Preview geometry: exactly the output region (the crop when applied), downscaled for display only.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const src = crop ?? { x: 0, y: 0, width: image.width, height: image.height }
    const scale = Math.min(1, PREVIEW_MAX / Math.max(src.width, src.height))
    view.current = { src, scale }
    canvas.width = Math.round(src.width * scale)
    canvas.height = Math.round(src.height * scale)
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.imageSmoothingQuality = 'high'
    buildBackground()
    drawRegion(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, cutout, crop?.x, crop?.y, crop?.width, crop?.height])

  /** Paint the selected background for the preview's output region (same routine export uses at full size). */
  function buildBackground() {
    const canvas = canvasRef.current
    try {
      bgLayer.current = canvas && background ? backgroundLayer(background, canvas.width, canvas.height, canvas2d) : null
    } catch {
      bgLayer.current = null
    }
  }
  // Mode or colour changed: rebuild the layer and redraw at once; only the selected type is ever drawn.
  const firstBackground = useRef(true)
  useEffect(() => {
    if (firstBackground.current) {
      firstBackground.current = false
      return
    }
    buildBackground()
    drawRegion(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [background])

  // FR-19: edge changes are computed off the main thread, latest value wins. While a brush stroke is active the
  // change waits for pointer-up (PRD edge case), so the stroke in progress is never disturbed.
  const edgeDeferred = useRef(false)
  function requestEdge() {
    const eng = engine.current
    if (!eng) return
    if (live.current) {
      edgeDeferred.current = true
      return
    }
    const value = latest.current.edit.edgeValue
    if (value === eng.requested) return
    eng.requested = value
    eng.requestedAt = performance.now()
    eng.edges.request(value)
  }
  function applyEdgeResult(eng: Engine, mask: Uint8ClampedArray) {
    schedule(eng.editor.setBase(mask), eng.requestedAt) // strokes are replayed on top of the new matte
  }
  useEffect(() => {
    requestEdge()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.edgeValue])


  // Strokes changed outside live painting (reset, undo/redo): reconcile the mask. During a live stroke this waits
  // for pointer-up so the stroke being painted is not wiped by a rebuild.
  const strokesDeferred = useRef(false)
  useEffect(() => {
    const eng = engine.current
    if (!eng) return
    if (live.current) strokesDeferred.current = true
    else schedule(eng.editor.sync(edit.strokes))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.strokes])

  /** Client coordinates → image pixels, honouring object-fit: contain letterboxing. */
  const toImage = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!
    const box = canvas.getBoundingClientRect()
    const { src } = view.current
    const k = Math.min(box.width / src.width, box.height / src.height) || 1
    const offX = (box.width - src.width * k) / 2
    const offY = (box.height - src.height * k) / 2
    return { x: src.x + (clientX - box.left - offX) / k, y: src.y + (clientY - box.top - offY) / k, k }
  }

  /** Draw the brush footprint centred on a client point (or the preview centre). */
  const showCursor = (clientX?: number, clientY?: number) => {
    const canvas = canvasRef.current
    const cursor = cursorRef.current
    if (!canvas || !cursor) return
    const box = canvas.getBoundingClientRect()
    const parent = cursor.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const cx = clientX ?? box.left + box.width / 2
    const cy = clientY ?? box.top + box.height / 2
    const { k } = toImage(cx, cy)
    const d = Math.max(2, 2 * latest.current.edit.brushRadius * k)
    cursor.style.width = cursor.style.height = `${d}px`
    cursor.style.transform = `translate(${cx - parent.left - d / 2}px, ${cy - parent.top - d / 2}px)`
    cursor.hidden = false
  }
  const hideCursor = () => {
    if (cursorRef.current) cursorRef.current.hidden = true
  }

  // Changing the size shows the footprint at the preview centre for a moment (FR-17 "visible size preview").
  const firstRadius = useRef(true)
  useEffect(() => {
    if (firstRadius.current) {
      firstRadius.current = false
      return
    }
    if (live.current) return
    showCursor()
    const t = setTimeout(hideCursor, 900)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.brushRadius])

  const addPoint = (e: { clientX: number; clientY: number; timeStamp: number }) => {
    const stroke = live.current
    const eng = engine.current
    if (!stroke || !eng) return
    const { x, y } = toImage(e.clientX, e.clientY)
    const last = stroke.points[stroke.points.length - 1]
    if (stroke.points.length > 0 && Math.abs(last.x - x) < 0.5 && Math.abs(last.y - y) < 0.5) return
    stroke.points.push({ x, y })
    schedule(eng.editor.stamp(stroke, stroke.points.length - 1), e.timeStamp)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !engine.current || cropping) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const { brushMode, brushRadius } = latest.current.edit
    live.current = { mode: brushMode, radius: brushRadius, points: [] }
    addPoint(e)
    showCursor(e.clientX, e.clientY)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (cropping) return hideCursor()
    if (e.pointerType !== 'touch' || live.current) showCursor(e.clientX, e.clientY)
    if (!live.current) return
    const events = e.nativeEvent.getCoalescedEvents?.() ?? []
    for (const ev of events.length ? events : [e]) addPoint(ev)
  }

  const endStroke = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const stroke = live.current
    const eng = engine.current
    live.current = null
    if (e.pointerType === 'touch') hideCursor()
    if (stroke && eng && stroke.points.length > 0) {
      const strokes = [...latest.current.edit.strokes, stroke]
      eng.editor.commit(strokes) // already painted live; the store update must not stamp it twice
      latest.current.onStroke(stroke)
    }
    if (strokesDeferred.current && eng) {
      // Strokes changed under the live stroke (e.g. undo mid-drag): replay everything once on top of the base.
      strokesDeferred.current = false
      if (!(stroke && stroke.points.length > 0)) eng.editor.commit(latest.current.edit.strokes)
      schedule(eng.editor.rebuild())
    }
    // Edge changes held back during the stroke apply now, on top of the committed stroke.
    if (eng?.pending) {
      const { mask } = eng.pending
      eng.pending = null
      applyEdgeResult(eng, mask)
    }
    if (edgeDeferred.current) {
      edgeDeferred.current = false
      requestEdge()
    }
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        className="edit-canvas"
        role="img"
        aria-label={`Background removed: ${image.fileName}`}
        data-testid="source-preview"
        data-brush={edit.brushMode}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onPointerLeave={() => {
          if (!live.current) hideCursor()
        }}
      />
      <div ref={cursorRef} className={`brush-cursor is-${edit.brushMode}`} data-testid="brush-cursor" aria-hidden="true" hidden />
      {cropDraft && (
        <CropOverlay
          canvasRef={canvasRef}
          imageWidth={image.width}
          imageHeight={image.height}
          rect={cropDraft}
          onChange={(r) => onCropDraftChange?.(r)}
          onApply={() => onCropApply?.()}
          onCancel={() => onCropCancel?.()}
        />
      )}
    </>
  )
}
