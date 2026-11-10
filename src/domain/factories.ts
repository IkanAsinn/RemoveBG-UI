import {
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  EDGE_VALUE_DEFAULT,
  EDGE_VALUE_MAX,
  EDGE_VALUE_MIN,
  type BackgroundSelection,
  type BatchItem,
  type BatchJob,
  type BrushStroke,
  type CutoutResult,
  type EditState,
  type ExportRequest,
  type SourceImage,
} from './types'

export const newId = (): string => crypto.randomUUID()

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
export const clampBrushRadius = (r: number): number => clamp(Math.round(r), BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX)
export const clampEdgeValue = (v: number): number => clamp(Math.round(v), EDGE_VALUE_MIN, EDGE_VALUE_MAX)

export function createSourceImage(init: Omit<SourceImage, 'id'> & { id?: string }): SourceImage {
  return { ...init, id: init.id ?? newId() }
}

export function createCutoutResult(
  init: Pick<CutoutResult, 'sourceImageId' | 'modelTier' | 'cutoutBitmap' | 'alphaMask'> & Partial<CutoutResult>,
): CutoutResult {
  return { status: 'pending', errorCode: null, ...init, id: init.id ?? newId() }
}

export function createEditState(cutoutId: string, init: Partial<Omit<EditState, 'cutoutId'>> = {}): EditState {
  return {
    brushMode: 'erase',
    strokes: [],
    crop: null,
    ...init,
    brushRadius: clampBrushRadius(init.brushRadius ?? 30),
    edgeValue: clampEdgeValue(init.edgeValue ?? EDGE_VALUE_DEFAULT),
    id: init.id ?? newId(),
    cutoutId,
  }
}

export function createBrushStroke(mode: BrushStroke['mode'], radius: number, points: BrushStroke['points'] = []): BrushStroke {
  return { mode, radius: clampBrushRadius(radius), points }
}

export function createBackgroundSelection(init: Partial<BackgroundSelection> = {}): BackgroundSelection {
  return {
    type: 'transparent',
    color: null,
    imageBlob: null,
    imageBitmap: null,
    gradientId: null,
    templateId: null,
    ...init,
  }
}

export function createBatchItem(sourceImageId: string, init: Partial<BatchItem> = {}): BatchItem {
  return {
    cutoutId: null,
    editStateId: null,
    status: 'queued',
    errorCode: null,
    edited: false,
    ...init,
    id: init.id ?? newId(),
    sourceImageId,
  }
}

export function createBatchJob(items: BatchItem[], totalInputBytes: number, init: Partial<BatchJob> = {}): BatchJob {
  return { status: 'validating', createdAt: Date.now(), ...init, id: init.id ?? newId(), items, totalInputBytes }
}

export function createExportRequest(
  init: Pick<ExportRequest, 'sourceImageId' | 'outputWidth' | 'outputHeight'> & Partial<ExportRequest>,
): ExportRequest {
  return { format: 'png', editStateId: null, background: createBackgroundSelection(), ...init }
}
