import { EDGE_VALUE_DEFAULT, type EditState, type SessionStateLike, type SourceImage } from './types'

/** True when the user has changed anything since the auto-removal result (FR-9, FR-23). */
export function hasEdits(edit: EditState | undefined | null): boolean {
  return !!edit && (edit.strokes.length > 0 || edit.edgeValue !== EDGE_VALUE_DEFAULT || edit.crop !== null)
}

/** FR-21 / FR-31 / NFR-7: output = full source resolution, or the crop rectangle when one is applied. */
export function outputSize(source: Pick<SourceImage, 'width' | 'height'>, edit: EditState | undefined | null) {
  return edit?.crop ? { width: edit.crop.width, height: edit.crop.height } : { width: source.width, height: source.height }
}

/** The EditState attached to any cutout of `imageId` (it follows the image across tiny → full replacement). */
export function editStateForImage(state: SessionStateLike, imageId: string): EditState | undefined {
  const cutoutIds = new Set(Object.values(state.cutouts).filter((c) => c.sourceImageId === imageId).map((c) => c.id))
  return Object.values(state.editStates).find((e) => cutoutIds.has(e.cutoutId))
}
