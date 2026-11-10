# Browser matrix (T-028: FR-55, NFR-3, R10)

`e2e/matrix.spec.ts` runs three flows in every engine available on the Windows test machine, against the production build. The flows are:

- Single image: upload, cutout, then a transparent full-resolution PNG download.
- HEIC upload.
- Batch of one good and one corrupt file, then a ZIP download.

Run it with `npx playwright test e2e/matrix.spec.ts`. Install the extra engines first with `npx playwright install firefox webkit`.

## Results (2026-11-10)

| Project | Engine | Single image PNG | HEIC | Batch → ZIP | Full model |
| --- | --- | --- | --- | --- | --- |
| chrome | Google Chrome 157 | Pass: 1200×800 RGBA, alpha kept | Pass (WASM decoder) | Pass (1 entry) | Upgraded |
| edge | Microsoft Edge 157 | Pass | Pass (WASM decoder) | Pass | Upgraded |
| firefox | Playwright Firefox 157 | Pass | Pass (WASM decoder) | Pass | Upgraded |
| webkit | Playwright WebKit 27.2 (Safari engine) | Pass | Pass (WASM decoder) | Pass | Upgraded |
| mobile-chrome | Chrome, Pixel 7 emulation | Pass | Pass (WASM decoder) | Pass | Upgraded |
| mobile-webkit | WebKit, iPhone 15 emulation | Pass | Pass (WASM decoder) | Pass | Upgraded |

## What each browser offered

| Feature | Chrome / Edge | Firefox | WebKit |
| --- | --- | --- | --- |
| Save picker (`showSaveFilePicker`) | Yes. ZIP and single exports use the native picker. | No. Falls back to a normal download / service-worker ZIP stream. | No. Same fallback as Firefox. |
| Service-worker ZIP streaming | Yes | Yes (see the fix below) | Yes |
| Clipboard image read | Yes | Yes | Yes |
| Cross-origin isolated (threaded WASM) | Yes | Yes | Yes |
| WebGPU | Yes | Yes | No. Uses WASM. |
| WebGL2 | Yes | Yes | Yes |
| OffscreenCanvas | Yes | Yes | No. Uses a DOM canvas. |
| Export formats | PNG, WebP; JXL disabled | PNG, WebP; JXL disabled | PNG, WebP; JXL disabled |
| HEIC decoding | Bundled WASM | Bundled WASM | Bundled WASM here. Real Safari decodes HEIC natively. |

During these runs, the network check found requests only to the app's own origin.

## Fixes found by the matrix

1. **WebKit could not start the full-model worker.**
   - Cause: Vite's `server.headers` / `preview.headers` were missing from `304 Not Modified` responses. When WebKit revalidated the worker script, the response had no COEP header, so it refused the worker ("Worker load was blocked by Cross-Origin-Embedder-Policy"). The app then stayed on the tiny model.
   - Fix: `vite.config.ts` now sets COOP and COEP in middleware on every response, 304s included.
   - **Deployment requirement:** production hosting must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on every response, 304s included.
2. **Firefox could leave the ZIP service worker stuck in `activating`.**
   - Cause: after a batch had run, the worker's `activate` waited on `clients.claim()`, and Firefox could leave it stuck there. "Writing ZIP…" then never finished.
   - Fix: activation no longer waits on `claim()` (`public/zip-sw.js`).

## Not covered here

- Real Safari on macOS and iOS. Playwright's WebKit on Windows is the same engine but not the same browser. Native HEIC, the clipboard permission UI, download handling and memory limits can differ.
- Real Android and iOS devices. The mobile projects only emulate the viewport, touch and user agent.
- "Last two versions" (NFR-3). Only the current installed versions were tested.
- JXL output. No tested browser encodes JXL, so the option was disabled everywhere (OQ-6). Where an encoder exists, the same code path produces the file.

Check these by hand on real devices before release, using the same three flows.
