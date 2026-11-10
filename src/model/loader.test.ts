// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearModelCache, loadModel, ModelLoadError, type LoadOptions } from './loader'
import { ALLOWED_MODEL_LICENSES, assertManifestValid, MODEL_MANIFEST, modelUrl } from './manifest'

const realTiny = new Uint8Array(readFileSync(join(import.meta.dirname, '../../public/models/u2netp.onnx')))
const fakeSession = { run: vi.fn(), release: vi.fn() }
const createSession = vi.fn(async () => ({ session: fakeSession }))

/** A Response that streams `bytes` in 1 MB chunks, like a real download. */
const streamed = (bytes: Uint8Array) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 1 << 20) c.enqueue(bytes.subarray(i, i + (1 << 20)))
        c.close()
      },
    }),
  )

const load = (fetchImpl: LoadOptions['fetchImpl'], extra: LoadOptions = {}) => loadModel('tiny', { fetchImpl, createSession, ...extra })
const failure = (p: Promise<unknown>) => p.then(() => null, (e: ModelLoadError) => e)

afterEach(() => {
  clearModelCache()
  createSession.mockClear()
})

describe('model manifest', () => {
  it('exposes same-origin tiny and full model URLs with MIT/Apache-2.0 licence metadata', () => {
    for (const tier of ['tiny', 'full'] as const) {
      const m = MODEL_MANIFEST[tier]
      expect(modelUrl(tier)).toBe(`/${m.path}`)
      expect(modelUrl(tier)).toMatch(/^\/models\/[\w.-]+\.onnx$/)
      expect(ALLOWED_MODEL_LICENSES).toContain(m.license)
      expect(m.licenseUrl).toMatch(/LICENSE/)
    }
    expect(MODEL_MANIFEST.tiny.id).toBe('u2netp')
    expect(MODEL_MANIFEST.full.id).toBe('isnet-general-use')
  })

  it('guard rejects non-commercial licences and cross-origin paths', () => {
    const ok = MODEL_MANIFEST.tiny
    expect(() => assertManifestValid({ tiny: ok, full: { ...ok, license: 'CC-BY-NC-4.0' } })).toThrow(/only MIT or Apache-2.0/)
    expect(() => assertManifestValid({ tiny: { ...ok, path: 'https://cdn.example.com/m.onnx' }, full: ok })).toThrow(/same-origin/)
    expect(() => assertManifestValid({ tiny: { ...ok, path: '//cdn.example.com/m.onnx' }, full: ok })).toThrow(/same-origin/)
    expect(() => assertManifestValid({ tiny: ok })).toThrow(/missing the "full" tier/)
  })
})

describe('loadModel (LOCAL /model/load)', () => {
  it('returns a typed handle after a verified download; the request is a body-less same-origin GET', async () => {
    const fetchImpl = vi.fn(async () => streamed(realTiny))
    const progress: number[] = []
    const handle = await load(fetchImpl, { onProgress: (l, t) => progress.push(l / t) })

    expect(handle).toMatchObject({ tier: 'tiny', backend: 'wasm', session: fakeSession })
    expect(handle.info.id).toBe('u2netp')
    expect(createSession).toHaveBeenCalledWith(expect.any(Uint8Array), 'wasm')
    expect(progress.at(-1)).toBe(1)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/models/u2netp.onnx') // no query string
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined() // no image bytes, no payload of any kind
    expect(init.credentials).toBe('same-origin')
  })

  it('shares one in-flight load between concurrent callers', async () => {
    const fetchImpl = vi.fn(async () => streamed(realTiny))
    const [a, b] = await Promise.all([load(fetchImpl), load(fetchImpl)])
    expect(a).toBe(b)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['network failure', async () => Promise.reject(new TypeError('Failed to fetch')), 'fetch'],
    ['HTTP 404', async () => new Response('nope', { status: 404 }), 'fetch'],
    ['truncated bytes', async () => streamed(realTiny.subarray(0, 1000)), 'corrupt'],
    ['tampered bytes', async () => streamed(Uint8Array.from(realTiny, (b, i) => (i === 5000 ? b ^ 0xff : b))), 'corrupt'],
    ['oversized bytes', async () => streamed(new Uint8Array(realTiny.length + 10)), 'corrupt'],
  ] as const)('%s → ModelLoadError kind "%s"', async (_label, fetchImpl, kind) => {
    const err = await failure(load(fetchImpl))
    expect(err).toBeInstanceOf(ModelLoadError)
    expect(err).toMatchObject({ kind, tier: 'tiny' })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('a download that stops sending bytes → kind "timeout"', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(realTiny.subarray(0, 100))
              init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
            },
          }),
        ),
    )
    const err = await failure(load(fetchImpl as typeof fetch, { stallTimeoutMs: 50 }))
    expect(err).toMatchObject({ kind: 'timeout' })
  })

  it('session creation failure → kind "init"', async () => {
    const err = await failure(
      loadModel('tiny', { fetchImpl: async () => streamed(realTiny), createSession: async () => Promise.reject(new Error('bad graph')) }),
    )
    expect(err).toMatchObject({ kind: 'init', message: expect.stringContaining('bad graph') })
  })

  it('a failed load is evicted so a retry fetches again and can succeed', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async () => streamed(realTiny))
    expect(await failure(load(fetchImpl))).toMatchObject({ kind: 'fetch' })
    await expect(load(fetchImpl)).resolves.toMatchObject({ tier: 'tiny' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
