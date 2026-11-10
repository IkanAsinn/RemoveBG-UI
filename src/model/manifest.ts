// ModelManifest (FR-53, NFR-14, NFR-18): the build-time model selection for each tier, with licence metadata.
// Model files are served same-origin from /models/ (fetched into public/models by `npm run models:fetch`).

import type { ModelTier } from '../domain'
import manifestJson from './manifest.json'

export interface ModelInfo {
  id: string
  file: string
  /** Path relative to the app base URL. Must stay same-origin. */
  path: string
  bytes: number
  sha256: string
  license: string
  licenseUrl: string
  /** Where the build fetched the file from. Never requested at runtime. */
  source: string
  inputSize: number
  mean: [number, number, number]
  std: [number, number, number]
}

export type ModelManifest = Record<ModelTier, ModelInfo>

export const ALLOWED_MODEL_LICENSES = ['MIT', 'Apache-2.0'] as const

/** Throws if any tier's model is not commercially usable under MIT/Apache-2.0 or is not a same-origin path. */
export function assertManifestValid(manifest: Record<string, Partial<ModelInfo>>): asserts manifest is ModelManifest {
  for (const tier of ['tiny', 'full']) {
    const m = manifest[tier]
    if (!m) throw new Error(`Model manifest is missing the "${tier}" tier`)
    if (!(ALLOWED_MODEL_LICENSES as readonly string[]).includes(m.license ?? '')) {
      throw new Error(`Model "${m.id}" (${tier}) has licence "${m.license}"; only ${ALLOWED_MODEL_LICENSES.join(' or ')} are allowed`)
    }
    if (!m.path || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(m.path)) {
      throw new Error(`Model "${m.id}" (${tier}) path "${m.path}" must be a same-origin relative path`)
    }
    if (!/^[0-9a-f]{64}$/.test(m.sha256 ?? '') || !m.bytes) throw new Error(`Model "${m.id}" (${tier}) needs sha256 and bytes`)
  }
}

const raw: Record<string, Partial<ModelInfo>> = manifestJson as unknown as Record<string, Partial<ModelInfo>>
assertManifestValid(raw)
export const MODEL_MANIFEST: ModelManifest = raw

/** Same-origin URL for a tier, honouring the Vite base path. */
export const modelUrl = (tier: ModelTier, base: string = import.meta.env.BASE_URL): string => `${base}${MODEL_MANIFEST[tier].path}`
