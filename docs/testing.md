# Testing

| Command | What it runs |
| --- | --- |
| `npm test` | Vitest unit and component tests (`src/**/*.test.ts(x)`, jsdom). |
| `npm run e2e` | Playwright end-to-end happy path (`e2e/`) against the production build in Google Chrome. |

## End-to-end happy path (T-029)

`e2e/happy-path.spec.ts` drives the real app with the real models:

1. Empty state, with no editor and no account prompt.
2. Upload `e2e/fixtures/photo.png`.
3. Tiny result. The processing phases shown are recorded.
4. Full-model upgrade when the device passes the capability gate. A device that fails the gate keeps the tiny result.
5. Erase and restore strokes, checked on preview pixels.
6. Edge softness +5.
7. Keyboard crop.
8. Solid background.
9. Download PNG.

Then it checks:

- The file name is `photo-nobg.png`.
- The PNG is crop-sized and RGBA, with only IHDR/IDAT/IEND chunks.
- The file's pixels equal the editor preview, so no watermark was added.
- Every request is a same-origin GET with no body, and there are no WebSockets.
- No dialogs, account buttons or account links appear.

Notes:

- The config starts `npm run build && vite preview` on port 4173. If a server is already listening there it is reused, so rebuild first (`npm run build`) or the test runs against a stale `dist/`.
- It uses the installed Google Chrome (`channel: 'chrome'`). To use Playwright's bundled Chromium instead, run `npx playwright install chromium` and then `E2E_CHANNEL=chromium npm run e2e`.
- The native save picker can't be driven from a test, so the spec removes `showSaveFilePicker` and covers the plain download path. The picker path is covered by `src/export/single.test.ts` and `src/App.export.test.tsx`.
- Results and traces of failed runs go to `node_modules/.e2e-results/`.

## Failure and empty states (T-030)

`e2e/failures.spec.ts` runs each failure in Chrome on the production build. The unit and component tests cover the same paths with mocks.

| Scenario (PRD) | Browser (e2e/failures.spec.ts) | Unit / component |
| --- | --- | --- |
| Empty home: no canvas, background or export panel | happy-path step 1 | `App.test.tsx` |
| File picker canceled: no change, no error | `file picker canceled` | `App.ingest.test.tsx` |
| Corrupt file: names the file, "Unsupported or corrupt image." | `corrupt image …` | `App.ingest.test.tsx`, `image/ingest.test.ts` |
| HEIC native and WASM both fail: "HEIC decoding failed for this file." | `corrupt image …` (corrupt.heic) | `image/heic.test.ts`, `image/ingest.test.ts` |
| Empty clipboard / permission denied | `clipboard: …` | `App.paste.test.tsx` |
| Own background fails to decode; previous background stays | `own background …` | `App.background.test.tsx` |
| Template asset fails: placeholder and retry | (checked by hand in T-017 with a routed 404) | `BackgroundPanel.templates.test.tsx` |
| Tiny model fetch fails: blocking error, Retry | `tiny model fetch fails …` | `App.model.test.tsx` |
| Full model fails after tiny: tiny stays, "Retry full model" | `full model fails …` | `App.upgrade.test.tsx` |
| Canvas too large to export | `canvas too large …` | `export/single.test.ts`, `App.export.test.tsx` |
| Export encoder failure: edits, background and format kept | `encoder failure …` | `App.export.test.tsx` |
| Single export save canceled | `save picker canceled …` | `App.export.test.tsx` |
| Batch empty state, >20 files, >100 MB | `empty batch screen; …` | `batch/validate.test.ts`, `App.batch.test.tsx` |
| One failed batch item: ZIP holds only Done items | `one failed item …` (reads the ZIP's central directory) | `components/BatchScreen.test.tsx`, `batch/process.test.ts` |
| All items fail: summary, no ZIP | `all items fail …` | `components/BatchScreen.test.tsx` |
| ZIP save canceled / mid-stream write failure | `ZIP save canceled …` | `batch/download.test.ts`, `zip/stream.test.ts` |

In these tests:

- Browser failures are simulated in a few ways:
  - Corrupt fixtures (`e2e/fixtures/corrupt.*`).
  - `context.route` on the model files.
  - Stubs of `navigator.clipboard.read` and `showSaveFilePicker`.
  - An artificial canvas limit: `OffscreenCanvas#getContext` returns null above 900k px.
  - A rejecting `convertToBlob`.
- Tests that don't involve the full model abort its request, so they stay fast. The app then keeps the tiny result and shows its notice.

## Accessibility (T-027, NFR-12)

`e2e/a11y.spec.ts` covers two things.

**axe-core scans.** The rules are the WCAG 2.1 A/AA set, including colour contrast and accessible names. They run in both the light and the dark theme on these states:

- Home, and home with a decode error.
- The editor, with every background mode, crop mode and a saved export.
- Batch: empty, validation error, queued, done with a failure, and all failed.

**Keyboard-only journeys.** Every Tab stop must show a visible focus indicator.

- **Single image:**
  1. Open the file picker with Space.
  2. Pick background modes with the arrow keys, then a swatch and a template with Enter.
  3. Open crop. Focus moves onto the crop area. Resize with Shift+arrow keys, then press Escape (cancels) or Enter (applies). Focus returns to the Crop button.
  4. Choose the format with the arrow keys and press Download.
- **Batch:**
  1. Choose files from the keyboard and start the batch.
  2. Open a row's Edit, then go Back to queue.
  3. Download the ZIP.

Limits of the automated checks:

- axe cannot judge text drawn over images or gradients. It reports those as "incomplete", not as passes.
- Non-text contrast of focus rings (WCAG 1.4.11) is not checked by axe. The focus colour is `#1f5eff` on `#f7f7f5` in light (5.1:1) and `#8fb0ff` on `#141414` in dark.
- Painting erase and restore strokes on the canvas needs a pointer. There is no keyboard brush. Every other control has a keyboard path.

## Flat graphics and the edge-aware brush

The AI models segment one salient subject. They are unreliable on images with no single subject, such as a page of
line art: the gaps between lines can come out half transparent, and white lines on black can disappear. Images that
are a uniform background plus a few flat ink colours are therefore keyed by colour instead (`src/matte/colorKey.ts`),
and the full model is never fetched for them. The editor's **Cutout** switch redoes the cutout with the other method.

`e2e/fixtures/photo.png` is a shaded sphere on a gradient, so it stays on the AI path. `e2e/fixtures/lines.png` is wavy
black line art on white.

| Check | Where |
| --- | --- |
| Line art (black on white, white on black, noisy paper, multi-colour logo) is keyed; gaps 0, ink 255, anti-aliasing partial | `src/matte/colorKey.test.ts` |
| Vignettes, soft blobs, textured subjects and mixed borders stay on the AI model | `src/matte/colorKey.test.ts` |
| A colour-keyed image never fetches the full model; switching methods keeps edits; full upgrade follows an AI switch | `src/App.matte.test.tsx`, `e2e/line-art.spec.ts` |
| Edits made while the full model loads carry over to the full cutout | `src/App.upgrade.test.tsx` |
| Edge-aware brush only erases/restores colours like the stroke's first point, and replays identically | `src/matte/applyEdits.test.ts`, `e2e/line-art.spec.ts` |

## Browser matrix, memory and security (T-028)

| Check | Where |
| --- | --- |
| Single image, HEIC and batch ZIP in Chrome, Edge, Firefox, WebKit and mobile emulation | `e2e/matrix.spec.ts` (results in [browser-matrix.md](browser-matrix.md)) |
| At most one item's full-resolution bitmaps alive during a batch (NFR-16) | `e2e/memory.spec.ts` (3 × 12 MP: peak 2 live bitmaps = one source + its cutout, 0 after) and `src/batch/process.test.ts` |
| Per-item decode, model-run and encode failures don't stop the batch | `src/batch/process.test.ts`, `e2e/failures.spec.ts` |
| No eval or Function constructor, trackers, external scripts or CDN assets in the build; models same-origin (NFR-18) | `npm run build && npm run audit:dist` (`scripts/audit-dist.mjs`) and `src/privacy.test.ts` |
| No silent downscale on oversized canvases | `e2e/failures.spec.ts` (canvas limit) and `src/export/single.test.ts` |
