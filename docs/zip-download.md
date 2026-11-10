# Batch ZIP download (OQ-8, OQ-9)

The batch ZIP is streamed to disk while it is written. The whole archive is never built in memory (FR-47). Code: `src/zip/stream.ts` (writer), `src/zip/save.ts` (destination), `src/batch/download.ts` (flow), `public/zip-sw.js` (fallback worker).

| Browser | Destination | What the user sees |
| --- | --- | --- |
| Chrome, Edge (desktop) | File System Access API: `showSaveFilePicker` then `FileSystemWritableFileStream` | A native "Save as" dialog, suggested name `nobg-images.zip`. The file is written as the ZIP streams. |
| Safari, Firefox, Chromium on Android | Streaming download served by the same-origin service worker `/zip-sw.js` | A normal browser download of `nobg-images.zip` that grows as the ZIP streams. There is no picker. |
| Service workers unavailable (for example, some private windows) | None | "This browser can't stream a ZIP download…". No file is produced. |

## Fallback mechanics

1. The page registers `/zip-sw.js` (scope `/`) and sends it a `MessagePort`.
2. A hidden iframe requests `/__zip-download/<id>/<name>`. The worker answers with `Content-Disposition: attachment` and a `ReadableStream` body.
3. The stream pulls one chunk at a time from the page. The writer's chunks are at most 4 MB, so memory stays bounded (NFR-8).
4. A keep-alive request goes out every 10 s, because some browsers stop idle workers.

The response carries CORP and COEP headers because the app is cross-origin isolated.

## Failures and cancellation

- **Picker canceled (FR-48):** nothing is written, and the batch stays as it was.
- **Browser download canceled:** the writer stops, and the UI reports "Save canceled".
- **Write fails mid-stream (FR-49):**
  - File System path: the writable stream is aborted, which discards the bytes written so far.
  - Fallback: the response stream is errored, so the browser marks the download as failed.
  - Either way the UI shows "ZIP download was incomplete" and never reports success.
- **Editing during a write:** editing is disabled from the click until the write ends, whatever the outcome.

## Verification

| Path | Where it was checked |
| --- | --- |
| File System Access API | Chromium only, with an OPFS stand-in for the native picker. |
| Service-worker streaming download | End to end in Chrome, Edge, Playwright Firefox, Playwright WebKit and mobile emulation (`e2e/matrix.spec.ts`). See [browser-matrix.md](browser-matrix.md). |

Real Safari on macOS and iOS, and real Android devices, still need a manual check before release.

**Firefox finding (T-028).** The worker used to activate with `waitUntil(clients.claim())`. After a batch had run, Firefox could leave the worker stuck in `activating`, and the page then waited forever. Activation no longer waits on `claim()`.
