// Pure pre/post-processing for the matting models (no DOM), mirroring rembg's pipeline.

/** RGBA pixels (inputSize², row-major) → normalised float32 NCHW tensor data [1, 3, S, S]. */
export function rgbaToInputTensor(
  rgba: Uint8ClampedArray,
  size: number,
  mean: readonly [number, number, number],
  std: readonly [number, number, number],
): Float32Array {
  const plane = size * size
  // rembg divides by the image's own max channel value (not a fixed 255) before mean/std.
  let max = 1e-6
  for (let i = 0; i < rgba.length; i += 4) max = Math.max(max, rgba[i], rgba[i + 1], rgba[i + 2])
  const out = new Float32Array(3 * plane)
  for (let p = 0; p < plane; p++) {
    const i = p * 4
    out[p] = (rgba[i] / max - mean[0]) / std[0]
    out[plane + p] = (rgba[i + 1] / max - mean[1]) / std[1]
    out[2 * plane + p] = (rgba[i + 2] / max - mean[2]) / std[2]
  }
  return out
}

/** First output channel → min-max normalised 0–255 matte, as an RGBA image whose alpha is the matte. */
export function matteToAlphaRgba(output: Float32Array, size: number): Uint8ClampedArray {
  const plane = size * size
  let min = Infinity
  let max = -Infinity
  for (let p = 0; p < plane; p++) {
    const v = output[p]
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min || 1
  const rgba = new Uint8ClampedArray(plane * 4)
  for (let p = 0; p < plane; p++) {
    const i = p * 4
    rgba[i] = rgba[i + 1] = rgba[i + 2] = 255
    rgba[i + 3] = ((output[p] - min) / range) * 255
  }
  return rgba
}
