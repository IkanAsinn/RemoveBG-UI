// Shared Data Model (PRD § Data Model). All entities are in-memory session state only.

/** Status / kind value lists. Each `as const` array doubles as a runtime enum and a union type. */
export const SOURCE_KINDS = ['upload', 'clipboard', 'batch'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const DECODE_PATHS = ['native', 'wasm-heic'] as const
export type DecodePath = (typeof DECODE_PATHS)[number]

export const MODEL_TIERS = ['tiny', 'full'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/** How a cutout's matte was made: the AI model, or a colour key of a flat background (line art, logos). */
export const MATTE_SOURCES = ['model', 'color'] as const
export type MatteSource = (typeof MATTE_SOURCES)[number]
/** Requested matting: 'auto' picks the colour key for flat graphics and the model for everything else. */
export type MatteMode = 'auto' | MatteSource

export const CUTOUT_STATUSES = ['pending', 'ready', 'failed'] as const
export type CutoutStatus = (typeof CUTOUT_STATUSES)[number]

export const BRUSH_MODES = ['erase', 'restore'] as const
export type BrushMode = (typeof BRUSH_MODES)[number]

export const BACKGROUND_TYPES = ['transparent', 'solid', 'image', 'gradient', 'template'] as const
export type BackgroundType = (typeof BACKGROUND_TYPES)[number]

export const BATCH_JOB_STATUSES = ['validating', 'ready', 'processing', 'editing', 'complete', 'failed'] as const
export type BatchJobStatus = (typeof BATCH_JOB_STATUSES)[number]

export const BATCH_ITEM_STATUSES = ['queued', 'processing', 'done', 'failed'] as const
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number]

export const EXPORT_FORMATS = ['png', 'webp', 'jxl'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** PRD ranges and limits. */
export const BRUSH_RADIUS_MIN = 1
export const BRUSH_RADIUS_MAX = 200
export const BRUSH_TOLERANCE_MIN = 1
export const BRUSH_TOLERANCE_MAX = 100
export const BRUSH_TOLERANCE_DEFAULT = 30
export const EDGE_VALUE_MIN = 0
export const EDGE_VALUE_MAX = 100
export const EDGE_VALUE_DEFAULT = 50
export const CROP_MIN_SIZE = 16
export const BATCH_MAX_ITEMS = 20
export const BATCH_MAX_BYTES = 104_857_600

export interface SourceImage {
  id: string
  fileName: string
  mimeType: string
  byteSize: number
  width: number
  height: number
  sourceKind: SourceKind
  originalBlob: Blob
  decodedBitmap: ImageBitmap
  decodePath: DecodePath
}

export interface CutoutResult {
  id: string
  sourceImageId: string // -> SourceImage.id
  modelTier: ModelTier
  matteSource: MatteSource
  cutoutBitmap: ImageBitmap
  alphaMask: Uint8ClampedArray
  status: CutoutStatus
  errorCode: string | null
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrushStroke {
  mode: BrushMode
  radius: number
  points: Array<{ x: number; y: number }>
  /**
   * Edge-aware stroke: only pixels whose source colour is within `tolerance` of `color` (the colour under the
   * stroke's first point) are affected, so the brush stops at edges. Absent for a plain brush stroke.
   */
  edge?: { color: [number, number, number]; tolerance: number }
}

export interface EditState {
  id: string
  cutoutId: string // -> CutoutResult.id
  brushMode: BrushMode
  brushRadius: number // image pixels, 1–200
  brushEdgeAware: boolean // edge-aware brush on/off (tool setting, not an edit)
  brushTolerance: number // 1–100, colour tolerance of the edge-aware brush
  strokes: BrushStroke[]
  edgeValue: number // 0–100, default 50
  crop: CropRect | null
}

export interface BackgroundSelection {
  type: BackgroundType
  color: string | null // hex
  imageBlob: Blob | null
  imageBitmap: ImageBitmap | null
  gradientId: string | null // -> GradientAsset.id
  templateId: string | null // -> TemplateAsset.id
}

export interface BatchItem {
  id: string
  sourceImageId: string // -> SourceImage.id
  cutoutId: string | null // -> CutoutResult.id
  editStateId: string | null // -> EditState.id
  status: BatchItemStatus
  errorCode: string | null
  edited: boolean
}

export interface BatchJob {
  id: string
  items: BatchItem[] // 1–20
  totalInputBytes: number
  status: BatchJobStatus
  createdAt: number // session timestamp only
}

export interface ExportRequest {
  format: ExportFormat
  sourceImageId: string // -> SourceImage.id
  editStateId: string | null // -> EditState.id
  background: BackgroundSelection
  outputWidth: number
  outputHeight: number
}

export interface TemplateAsset {
  id: string
  name: string
  assetUrl: string // bundled local asset
  width: number
  height: number
}

export interface GradientAsset {
  id: string
  name: string
  cssValue: string
}

/** Minimal shape of the session needed by pure helpers (avoids a types → store import cycle). */
export interface SessionStateLike {
  cutouts: Record<string, CutoutResult>
  editStates: Record<string, EditState>
}
