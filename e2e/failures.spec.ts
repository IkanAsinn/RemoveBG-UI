// T-030: failure and empty states in a real browser on the production build. Each test forces one failure (corrupt
// files, intercepted model requests, stubbed browser APIs, an artificial canvas limit) and checks the PRD message, that
// the UI stays usable, that edits survive where required, and that nothing partial is reported as a success.
// Complements the unit/component tests listed in docs/testing.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const TINY = '**/models/u2netp.onnx'
const FULL = '**/models/isnet-general-use.onnx'

/** Most tests do not need the 178 MB full model; failing it fast keeps them quick (the tiny result stays). */
const skipFullModel = (context: BrowserContext) => context.route(FULL, (r) => r.abort())

async function openEditor(page: Page) {
  await page.goto('/')
  await page.getByTestId('upload-input').setInputFiles(fixture('photo.png'))
  await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 120_000 })
}

/** Files built inside the page (large or many), delivered to a file input as if the user picked them. */
async function pickInPage(page: Page, testId: string, files: { name: string; bytes: number }[]) {
  await page.evaluate(
    ([testId, files]) => {
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'image/png' }))
      const input = document.querySelector<HTMLInputElement>(`[data-testid=${testId}]`)!
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    [testId, files] as const,
  )
}

/** File names in a ZIP, read from its central directory. */
function zipNames(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocd).toBeGreaterThan(0)
  const count = buf.readUInt16LE(eocd + 10)
  let o = buf.readUInt32LE(eocd + 16)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(o)).toBe(0x02014b50)
    const n = buf.readUInt16LE(o + 28)
    const m = buf.readUInt16LE(o + 30)
    const k = buf.readUInt16LE(o + 32)
    names.push(buf.toString('utf8', o + 46, o + 46 + n))
    o += 46 + n + m + k
  }
  return names
}

test.describe('input failures', () => {
  test.beforeEach(({ context }) => skipFullModel(context))

  test('file picker canceled: no state change, no error', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('upload-input').setInputFiles([])
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('canvas')).toHaveCount(0)
  })

  test('corrupt image names the file; HEIC failing both decoders says so; upload stays usable', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('upload-input').setInputFiles(fixture('corrupt.png'))
    await expect(page.getByRole('alert')).toContainText('corrupt.png')
    await expect(page.getByRole('alert')).toContainText('Unsupported or corrupt image.')
    await page.getByTestId('upload-input').setInputFiles(fixture('corrupt.heic'))
    await expect(page.getByRole('alert')).toContainText('HEIC decoding failed for this file.', { timeout: 60_000 })
    await expect(page.locator('canvas')).toHaveCount(0)
    // Still usable: a good file goes through.
    await page.getByTestId('upload-input').setInputFiles(fixture('photo.png'))
    await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 120_000 })
  })

  test('clipboard: empty shows a non-blocking notice; denied permission points to upload', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/')
    await page.evaluate(() => navigator.clipboard.writeText('just text'))
    await page.getByRole('button', { name: 'Paste' }).click()
    await expect(page.getByText('No image found on the clipboard.')).toBeVisible()
    await expect(page.getByTestId('upload-input')).toBeEnabled()

    await page.evaluate(() => {
      navigator.clipboard.read = () => Promise.reject(new DOMException('Read permission denied.', 'NotAllowedError'))
    })
    await page.getByRole('button', { name: 'Paste' }).click()
    await expect(page.getByText('Clipboard image paste is not available in this browser. Use upload instead.')).toBeVisible()
    await page.getByTestId('upload-input').setInputFiles(fixture('photo.png'))
    await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 120_000 })
  })

  test('own background that cannot be decoded keeps the previous background', async ({ page }) => {
    await openEditor(page)
    await page.locator('label.bg-mode', { hasText: 'Solid color' }).click()
    await page.getByRole('button', { name: '#1f5eff' }).click()
    await page.locator('label.bg-mode', { hasText: 'Own image' }).click()
    await page.getByTestId('background-image-input').setInputFiles(fixture('corrupt.png'))
    await expect(page.getByRole('alert')).toHaveText('Background image could not be decoded')
    await expect(page.getByRole('radio', { name: 'Solid color' })).toBeChecked() // back to what was shown before
    // The cutout still sits on the previous solid colour.
    const corner = await page.evaluate(() => [...document.querySelector<HTMLCanvasElement>('[data-testid=processing-view] canvas')!.getContext('2d')!.getImageData(1, 1, 1, 1).data])
    expect(corner).toEqual([31, 94, 255, 255])
    await expect(page.getByRole('button', { name: '#1f5eff' })).toHaveAttribute('aria-pressed', 'true')
  })
})

test.describe('model failures', () => {
  test('tiny model fetch fails: blocking error, nothing starts; Retry recovers', async ({ page, context }) => {
    await skipFullModel(context)
    await context.route(TINY, (r) => r.abort('internetdisconnected'))
    await page.goto('/')
    await page.getByTestId('upload-input').setInputFiles(fixture('photo.png'))
    const panel = page.getByTestId('model-error')
    await expect(panel).toContainText('Could not load the background-removal model. Check your connection and retry.', { timeout: 60_000 })
    await expect(page.getByRole('complementary', { name: 'Editing tools' })).toHaveCount(0)
    await context.unroute(TINY)
    await panel.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 120_000 })
  })

  test('full model fails after the tiny result: tiny stays, notice offers Retry full model', async ({ page, context }) => {
    await context.route(FULL, (r) => r.fulfill({ status: 404, body: 'missing' }))
    await openEditor(page)
    const view = page.getByTestId('processing-view')
    await expect(page.getByTestId('upgrade-notice')).toBeVisible({ timeout: 60_000 })
    await expect(view).toHaveAttribute('data-model-tier', 'tiny')
    await expect(view).toHaveAttribute('data-full-model', 'failed')
    // Editing stays available on the tiny result.
    await expect(page.getByRole('slider', { name: 'Edge softness' })).toBeEnabled()
    await context.unroute(FULL)
    await page.getByRole('button', { name: 'Retry full model' }).click()
    await expect(view).toHaveAttribute('data-full-model', /^(done|skipped)$/, { timeout: 180_000 })
  })
})

test.describe('export failures keep the session', () => {
  test.beforeEach(({ context }) => skipFullModel(context))

  async function editedSession(page: Page) {
    await openEditor(page)
    const edge = page.getByRole('slider', { name: 'Edge softness' })
    await edge.focus()
    for (let i = 0; i < 10; i++) await edge.press('ArrowRight')
    await page.locator('label.bg-mode', { hasText: 'Solid color' }).click()
    await page.getByRole('button', { name: '#e8433a' }).click()
    const downloads: string[] = []
    page.on('download', (d) => downloads.push(d.suggestedFilename()))
    return downloads
  }
  async function expectSessionKept(page: Page, downloads: string[]) {
    await expect(page.getByRole('slider', { name: 'Edge softness' })).toHaveValue('60')
    await expect(page.getByRole('radio', { name: 'Solid color' })).toBeChecked()
    await expect(page.getByRole('button', { name: '#e8433a' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('export-panel').getByRole('radio', { name: 'PNG' })).toBeChecked()
    await expect(page.getByTestId('export-result')).not.toContainText('Saved')
    expect(downloads).toEqual([])
  }

  test('canvas too large to export: error, no downscale, no file', async ({ page }) => {
    await page.addInitScript(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker)
    const downloads = await editedSession(page)
    // Simulate this browser's canvas limit just below the 1200 × 800 output.
    await page.evaluate(() => {
      const get = OffscreenCanvas.prototype.getContext
      OffscreenCanvas.prototype.getContext = function (this: OffscreenCanvas, ...a: Parameters<typeof get>) {
        return this.width * this.height >= 900_000 ? null : get.apply(this, a)
      } as typeof get
    })
    await page.getByRole('button', { name: 'Download PNG' }).click()
    await expect(page.getByTestId('export-result')).toHaveText('This image is too large to export on this browser.')
    await expect(page.getByTestId('export-result')).toHaveAttribute('role', 'alert')
    await expectSessionKept(page, downloads)
  })

  test('encoder failure: error, same format, no file', async ({ page }) => {
    await page.addInitScript(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker)
    const downloads = await editedSession(page)
    await page.evaluate(() => {
      OffscreenCanvas.prototype.convertToBlob = () => Promise.reject(new Error('encoder failure'))
    })
    await page.getByRole('button', { name: 'Download PNG' }).click()
    await expect(page.getByTestId('export-result')).toHaveText('Could not encode the image as PNG. Your edits and background are unchanged.')
    await expectSessionKept(page, downloads)
  })

  test('save picker canceled: nothing written, editor intact', async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as unknown as { showSaveFilePicker: () => Promise<never> }).showSaveFilePicker = () =>
        Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
    })
    const downloads = await editedSession(page)
    await page.getByRole('button', { name: 'Download PNG' }).click()
    await expect(page.getByTestId('export-result')).toHaveText('Save canceled. Nothing was written.')
    await expectSessionKept(page, downloads)
  })
})

test.describe('batch and ZIP', () => {
  test.beforeEach(({ context }) => skipFullModel(context)) // batch falls back to the tiny model

  test('empty batch screen; more than 20 files and more than 100 MB are blocked before anything starts', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Process a batch' }).click()
    await expect(page.getByText('Up to 20 images · 100 MB total')).toBeVisible()

    await pickInPage(page, 'batch-input', Array.from({ length: 21 }, (_, i) => ({ name: `img-${i}.png`, bytes: 10 })))
    await expect(page.getByRole('alert')).toHaveText('Maximum 20 images per batch.')
    await expect(page.getByRole('table', { name: 'Batch queue' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start batch' })).toHaveCount(0)

    await pickInPage(page, 'batch-input', [{ name: 'a.png', bytes: 60_000_000 }, { name: 'b.png', bytes: 50_000_000 }])
    await expect(page.getByRole('alert')).toContainText('110,000,000 bytes')
    await expect(page.getByRole('alert')).toContainText('The limit is 100 MB (104,857,600 bytes) per batch.')
    await expect(page.getByRole('table', { name: 'Batch queue' })).toHaveCount(0)
  })

  test('one failed item: others finish, the ZIP holds only Done items', async ({ page }) => {
    await page.addInitScript(() => delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker) // streaming download path
    await page.goto('/')
    await page.getByRole('button', { name: 'Process a batch' }).click()
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toHaveCount(0) // nothing queued yet
    await page.getByTestId('batch-input').setInputFiles([fixture('photo.png'), fixture('corrupt.png')])
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeDisabled() // nothing Done yet
    await page.getByRole('button', { name: 'Start batch' }).click()
    await expect(page.getByText('1 done · 1 failed')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('batch-failures')).toContainText('corrupt.png: Could not decode image')

    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download ZIP' }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('nobg-images.zip')
    const buf = readFileSync((await file.path())!)
    expect(zipNames(buf)).toEqual(['photo-nobg.png'])
    await expect(page.getByText(/ZIP saved with 1 image/)).toBeVisible()
  })

  test('all items fail: error summary lists each file, no ZIP offered', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Process a batch' }).click()
    await page.getByTestId('batch-input').setInputFiles([fixture('corrupt.png'), fixture('corrupt.heic')])
    await page.getByRole('button', { name: 'Start batch' }).click()
    const summary = page.getByTestId('batch-error-summary')
    await expect(summary).toContainText('No images could be processed, so no ZIP was created.', { timeout: 120_000 })
    await expect(summary.getByRole('listitem')).toHaveText([/^corrupt\.png: /, /^corrupt\.heic: /])
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toHaveCount(0)
  })

  test('ZIP save canceled keeps the batch; a mid-stream write failure is reported as incomplete, never saved', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __zipMode: string; __aborted: number; showSaveFilePicker: unknown }
      w.__zipMode = 'cancel'
      w.__aborted = 0
      w.showSaveFilePicker = async () => {
        if (w.__zipMode === 'cancel') throw new DOMException('The user aborted a request.', 'AbortError')
        // The destination opens, then the first chunk fails to write (a one-image ZIP is a single buffered chunk).
        return {
          createWritable: async () => ({
            write: async () => {
              throw new DOMException('Disk full', 'QuotaExceededError')
            },
            close: async () => {},
            abort: async () => void w.__aborted++,
          }),
        }
      }
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Process a batch' }).click()
    await page.getByTestId('batch-input').setInputFiles([fixture('photo.png')])
    await page.getByRole('button', { name: 'Start batch' }).click()
    await expect(page.getByText('1 done · 0 failed')).toBeVisible({ timeout: 120_000 })

    await page.getByRole('button', { name: 'Download ZIP' }).click()
    await expect(page.getByText('Save canceled. No ZIP was written; the batch is still here.')).toBeVisible()
    await expect(page.getByRole('table', { name: 'Batch queue' })).toContainText('Done')

    await page.evaluate(() => ((window as unknown as { __zipMode: string }).__zipMode = 'fail'))
    await page.getByRole('button', { name: 'Download ZIP' }).click()
    await expect(page.getByRole('alert')).toHaveText('ZIP download was incomplete')
    await expect(page.getByText(/ZIP saved/)).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __aborted: number }).__aborted)).toBe(1)
    await expect(page.getByRole('button', { name: 'Download ZIP' })).toBeEnabled() // the batch is still usable
  })
})
