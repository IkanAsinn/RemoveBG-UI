// T-028 / NFR-3 / R10: the core flows on every engine available here (see playwright.config.ts projects), plus a
// record of what each browser supports. Facts are attached as test annotations; docs/browser-matrix.md summarises them.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const note = (info: TestInfo, type: string, value: unknown) => info.annotations.push({ type, description: String(value) })

test.beforeEach(async ({ page }) => {
  // The native save picker (Chromium desktop) cannot be driven by a test: record it, then use the download fallback.
  await page.addInitScript(() => {
    ;(window as unknown as { __hadPicker: boolean }).__hadPicker = typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  })
})

async function browserFacts(page: Page, info: TestInfo) {
  const facts = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    const gl2 = !!c.getContext('webgl2')
    return {
      hadSavePicker: (window as unknown as { __hadPicker: boolean }).__hadPicker,
      serviceWorker: 'serviceWorker' in navigator,
      clipboardRead: typeof navigator.clipboard?.read === 'function',
      crossOriginIsolated: self.crossOriginIsolated,
      webgpu: 'gpu' in navigator,
      webgl2: gl2,
      offscreenCanvas: typeof OffscreenCanvas === 'function',
    }
  })
  for (const [k, v] of Object.entries(facts)) note(info, k, v)
  return facts
}

/** Decode a downloaded image in the page; returns its size and how many pixels are fully transparent. */
const decodeInPage = (page: Page, bytes: Buffer, type: string) =>
  page.evaluate(
    async ([b64, type]) => {
      const blob = new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type })
      const bm = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bm.width
      c.height = bm.height
      const cx = c.getContext('2d')!
      cx.drawImage(bm, 0, 0)
      const d = cx.getImageData(0, 0, bm.width, bm.height).data
      let transparent = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] === 0) transparent++
      return { width: bm.width, height: bm.height, transparent }
    },
    [bytes.toString('base64'), type] as const,
  )

test('single image: upload → cutout → transparent full-resolution PNG download (NFR-3)', async ({ page }, info) => {
  const offOrigin: string[] = []
  page.on('request', (r) => {
    const u = r.url()
    if (!u.startsWith('http://localhost:4173') && !u.startsWith('blob:') && !u.startsWith('data:')) offOrigin.push(u)
  })
  await page.goto('/')
  await browserFacts(page, info)
  await page.getByTestId('upload-input').setInputFiles(fixture('photo.png'))
  await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 180_000 })

  const view = page.getByTestId('processing-view')
  await expect(view).toHaveAttribute('data-full-model', /^(done|skipped|failed|interrupted)$/, { timeout: 280_000 })
  note(info, 'fullModel', await view.getAttribute('data-full-model'))
  note(info, 'modelTier', await view.getAttribute('data-model-tier'))

  const formats = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLInputElement>('input[name=export-format]')].map((i) => `${i.value}:${i.disabled ? 'off' : 'on'}`).join(' '),
  )
  note(info, 'exportFormats', formats)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PNG' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('photo-nobg.png')
  const bytes = readFileSync((await file.path())!)
  expect(bytes.subarray(1, 4).toString()).toBe('PNG')
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes[25]]).toEqual([1200, 800, 6]) // full size, RGBA
  const decoded = await decodeInPage(page, bytes, 'image/png')
  expect(decoded.transparent).toBeGreaterThan(0) // background removed, alpha kept
  note(info, 'pngExport', `ok ${decoded.width}x${decoded.height}, ${decoded.transparent} transparent px`)
  expect(offOrigin).toEqual([])
})

test('HEIC upload decodes (native or bundled WASM decoder)', async ({ page, context }, info) => {
  await context.route('**/models/isnet-general-use.onnx', (r) => r.abort())
  let wasm = false
  page.on('request', (r) => {
    if (/libheif/.test(r.url())) wasm = true
  })
  await page.goto('/')
  await page.getByTestId('upload-input').setInputFiles(fixture('photo.heic'))
  await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 180_000 })
  note(info, 'heicDecoder', wasm ? 'bundled WASM (libheif)' : 'native')
})

test('batch: one good and one corrupt file → ZIP of the good one (FR-44, OQ-9)', async ({ page }, info) => {
  // No request interception here: in Playwright's Firefox, interception bypasses the service worker that streams the ZIP.
  await page.goto('/')
  await page.getByRole('button', { name: 'Process a batch' }).click()
  await page.getByTestId('batch-input').setInputFiles([fixture('photo.png'), fixture('corrupt.png')])
  await page.getByRole('button', { name: 'Start batch' }).click()
  await expect(page.getByTestId('batch-progress')).toHaveText('1 done · 1 failed', { timeout: 180_000 })

  const download = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null)
  await page.getByRole('button', { name: 'Download ZIP' }).click()
  const outcome = page.getByText(/ZIP saved|can't stream|incomplete|canceled/i).first()
  await expect(outcome).toBeVisible({ timeout: 60_000 })
  const message = await outcome.innerText()
  note(info, 'zipOutcome', message)
  const file = await download
  expect(file, `ZIP download (${message})`).not.toBeNull()
  const buf = readFileSync((await file!.path())!)
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(buf.readUInt16LE(eocd + 10)).toBe(1)
  const name = buf.toString('utf8', buf.readUInt32LE(eocd + 16) + 46, buf.readUInt32LE(eocd + 16) + 46 + buf.readUInt16LE(buf.readUInt32LE(eocd + 16) + 28))
  expect(name).toBe('photo-nobg.png')
  note(info, 'zipPath', 'service-worker streaming download')
})
