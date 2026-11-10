// T-029: end-to-end happy path through the real modules (ingest → matte → edit → composite → export → save), on the
// production build, in a real browser with the real models. Run with `npm run e2e` (rebuild first if a preview server is
// already running, since an existing server is reused).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const FIXTURE = fileURLToPath(new URL('./fixtures/photo.png', import.meta.url))
const ACCOUNT_PROMPT = /sign ?in|log ?in|sign ?up|create (an )?account|subscribe|upgrade to pro|pricing/i

/** Visible text plus the names of every button and link, minus the app's own 'No signup' promise. */
async function accountPrompts(page: Page) {
  const text = (await page.locator('body').innerText()).replace(/no signup/gi, '')
  const controls = await page.getByRole('button').or(page.getByRole('link')).allTextContents()
  const dialogs = await page.getByRole('dialog').count()
  return { text: ACCOUNT_PROMPT.test(text), controls: controls.filter((c) => ACCOUNT_PROMPT.test(c)), dialogs }
}

/** PNG structure: size, colour type and the list of chunk types. */
function readPng(buf: Buffer) {
  expect(buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
  const chunks: string[] = []
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o)
    chunks.push(buf.toString('latin1', o + 4, o + 8))
    o += 12 + len
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25], chunks }
}

/** Alpha of the editor preview at a point given as fractions of the canvas size. */
const previewAlpha = (page: Page, fx: number, fy: number) =>
  page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid=processing-view] canvas')!
      return c.getContext('2d')!.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data[3]
    },
    [fx, fy],
  )

async function stroke(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator('[data-testid=processing-view] canvas').first().boundingBox())!
  const at = ([fx, fy]: [number, number]) => [box.x + box.width * fx, box.y + box.height * fy] as const
  await page.mouse.move(...at(from))
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    const t = i / 12
    await page.mouse.move(...at([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]))
  }
  await page.mouse.up()
}

test('upload → tiny → full → edit → background → full-resolution PNG, with no image bytes on the network', async ({ page, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin
  const requests: { method: string; url: string; body: number }[] = []
  page.on('request', (r) => requests.push({ method: r.method(), url: r.url(), body: r.postDataBuffer()?.length ?? 0 }))
  const sockets: string[] = []
  page.on('websocket', (ws) => sockets.push(ws.url()))
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.type())
    void d.dismiss()
  })

  await page.addInitScript(() => {
    // Use the plain browser download path; the native save picker cannot be driven from a test.
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    // Record every processing phase the indicator shows, however briefly.
    const seen = new Set<string>()
    ;(window as unknown as { __phases: Set<string> }).__phases = seen
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid=phase]')?.textContent
      if (t) seen.add(t.replace(/….*$/, ''))
    }).observe(document, { subtree: true, childList: true, characterData: true })
  })

  // 1. Empty state: upload/paste only, no editor, no account prompt.
  await page.goto('/')
  await expect(page.getByTestId('upload-input')).toBeAttached()
  await expect(page.locator('canvas')).toHaveCount(0)
  await expect(page.getByTestId('export-panel')).toHaveCount(0)
  expect(await accountPrompts(page)).toEqual({ text: false, controls: [], dialogs: 0 })

  // 2. Upload → tiny result with progress phases.
  await page.getByTestId('upload-input').setInputFiles(FIXTURE)
  const view = page.getByTestId('processing-view')
  await expect(page.getByRole('complementary', { name: 'Editing tools' })).toBeVisible({ timeout: 120_000 })
  const phases = await page.evaluate(() => [...(window as unknown as { __phases: Set<string> }).__phases])
  expect(phases).toContain('Removing background')

  // 3. Full-model upgrade when the device is capable (FR-12/FR-13); a device that fails the gate keeps the tiny result.
  await expect(view).toHaveAttribute('data-full-model', /^(done|skipped)$/, { timeout: 180_000 })
  const upgrade = await view.getAttribute('data-full-model')
  if (upgrade === 'done') await expect(view).toHaveAttribute('data-model-tier', 'full')
  testInfo.annotations.push({ type: 'full-model', description: `${upgrade}; phases seen: ${phases.join(', ')}` })

  // 4. Erase across the subject, then restore part of it (FR-17, FR-18).
  const before = await previewAlpha(page, 0.5, 0.5)
  expect(before).toBeGreaterThan(200) // the subject is opaque in the cutout
  await page.getByRole('slider', { name: 'Brush size' }).fill('60')
  await stroke(page, [0.3, 0.5], [0.7, 0.5])
  await expect.poll(() => previewAlpha(page, 0.5, 0.5)).toBe(0)
  await page.getByRole('radio', { name: 'Restore' }).check({ force: true })
  await stroke(page, [0.5, 0.35], [0.5, 0.65])
  await expect.poll(() => previewAlpha(page, 0.5, 0.5)).toBe(255)

  // 5. Edge softness (FR-19).
  const edge = page.getByRole('slider', { name: 'Edge softness' })
  await edge.focus()
  for (let i = 0; i < 5; i++) await edge.press('ArrowRight')
  await expect(edge).toHaveValue('55')

  // 6. Crop (FR-20/FR-21): shrink from two corners with the keyboard, then apply.
  await page.getByRole('button', { name: 'Crop image' }).click()
  const br = page.getByLabel('Resize crop from bottom-right corner')
  await br.focus()
  for (let i = 0; i < 15; i++) await br.press('Shift+ArrowLeft')
  for (let i = 0; i < 8; i++) await br.press('Shift+ArrowUp')
  const tl = page.getByLabel('Resize crop from top-left corner')
  await tl.focus()
  for (let i = 0; i < 6; i++) await tl.press('Shift+ArrowRight')
  await page.getByRole('button', { name: 'Apply crop' }).click()
  const sizeText = await page.getByTestId('output-size').innerText()
  const [, w, h] = /(\d+) × (\d+) px/.exec(sizeText)!.map(Number)
  expect(w).toBeLessThan(1200)
  expect(h).toBeLessThan(800)

  // 7. Solid background (FR-25).
  await page.locator('label.bg-mode', { hasText: 'Solid color' }).click()
  await page.getByRole('button', { name: '#1f5eff' }).click()

  // 8. Download the PNG (FR-30, FR-33): default format, full output resolution, {basename}-nobg.png.
  const exportPanel = page.getByTestId('export-panel')
  await expect(exportPanel.getByRole('radio', { name: 'PNG' })).toBeChecked()
  const download = page.waitForEvent('download')
  await exportPanel.getByRole('button', { name: 'Download PNG' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('photo-nobg.png')
  const path = testInfo.outputPath('photo-nobg.png')
  await file.saveAs(path)
  await expect(exportPanel.getByTestId('export-result')).toHaveText(`Saved photo-nobg.png (${w} × ${h} px).`)

  // 9. The file: crop-adjusted full resolution, RGBA, no text/metadata chunks that could carry branding (FR-34).
  const bytes = readFileSync(path)
  const png = readPng(bytes)
  expect([png.width, png.height]).toEqual([w, h])
  expect(png.colorType).toBe(6)
  expect(new Set(png.chunks)).toEqual(new Set(['IHDR', 'IDAT', 'IEND']))

  // 10. No watermark: the file's pixels equal what the editor shows (preview is 1:1 at this size).
  const cmp = await page.evaluate(async (b64) => {
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' })
    const bm = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const c = new OffscreenCanvas(bm.width, bm.height)
    const cx = c.getContext('2d')!
    cx.drawImage(bm, 0, 0)
    const a = cx.getImageData(0, 0, bm.width, bm.height).data
    const p = document.querySelector<HTMLCanvasElement>('[data-testid=processing-view] canvas')!
    const b = p.getContext('2d')!.getImageData(0, 0, p.width, p.height).data
    let max = 0
    let translucent = 0
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
    for (let i = 3; i < a.length; i += 4) if (a[i] !== 255) translucent++
    return { preview: [p.width, p.height], maxDiff: max, translucent, corner: [...a.subarray(0, 4)] }
  }, bytes.toString('base64'))
  expect(cmp.preview).toEqual([w, h])
  expect(cmp.maxDiff).toBeLessThanOrEqual(2)
  expect(cmp.translucent).toBe(0) // solid background: fully opaque
  expect(cmp.corner).toEqual([31, 94, 255, 255])

  // 11. Network: only same-origin GETs without bodies (app assets and models); no sockets; no account prompts.
  const offending = requests.filter((r) => r.method !== 'GET' || r.body > 0 || (!r.url.startsWith(origin) && !r.url.startsWith('blob:') && !r.url.startsWith('data:')))
  expect(offending).toEqual([])
  expect(sockets).toEqual([])
  expect(dialogs).toEqual([])
  expect(await accountPrompts(page)).toEqual({ text: false, controls: [], dialogs: 0 })
  testInfo.annotations.push({ type: 'network', description: `${requests.length} requests, all same-origin GET` })
})
