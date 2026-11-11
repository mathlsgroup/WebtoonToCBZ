# Webtoon to CBZ — v0.1 prototype

Firefox-first extension for archiving images you are authorized to save. Captures
image URLs while you read, offers review and ordering, and exports an ordinary ZIP
with a .cbz extension. No image conversion, telemetry, accounts, or external services.

## Requirements and commands

- Node.js 20+ and npm (checks performed with Node.js 26.13).
- Firefox Desktop 140+ on Windows. Android and other browsers have not been tested.

```powershell
npm ci
npm run lint
npm test
npm run check:extension
npm run dev
```

`npm run build` compiles into a staging directory and replaces `dist` only after
compilation and resource copying succeed. A failed build leaves the previous
complete build unchanged; do not treat that old build as the failed revision.
`npm test` builds and runs the Node regression tests.
`npm run check:extension` requires a successful build first.

`npm run dev` launches a temporary Firefox profile. To use your normal session,
open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
and select `dist/manifest.json`. Reload the add-on after rebuilding.

## Workflow

1. Open an authorized HTTP(S) chapter and complete any human verification yourself.
2. Click the extension icon, then **Start**. Starting again clears that capture.
3. Read/scroll through the chapter. Capture continues after the popup closes.
4. Click **Stop**, then **Open review and export tab**.
5. Check that every chapter page is present. Exclude ads, move pages with
   **Up/Down**, and enter a filename such as `Series - 0280`.
6. Export. Firefox asks for access to the image server origins when needed.
   Keep the review tab open until saving completes. The popup may close freely.

Exclusions, title, and manual ordering are retained in the source document until
a new capture starts or that document is closed/reloaded/navigated. Refresh does
not reset these choices. Source navigation invalidates an open review; it must
not silently export stale data.

## Capture and ordering

The content script is injected only when the user opens the extension on a tab.
Visible document images are considered as the user scrolls. Unloaded placeholders
reserve positions before downloads complete. Connected image elements follow DOM
order; URL duplicates are collapsed. Captured URLs remain available if elements
are removed or their source changes.

There is no minimum width/height filter: short or narrow strips remain reviewable.
This also means icons and ads can appear and must be excluded manually. Broken or
pending images encountered during reading are counted and block export. Load them
and recapture before exporting. This cannot detect chapter pages the site never
inserted or the user never reached; manually verify completeness.

## Export and data flow

The review tab fetches selected URLs sequentially, with a 30-second response
timeout per image, and checks JPEG, PNG, GIF, WebP, or AVIF signatures. It preserves
the returned bytes and names entries `0001.jpg`, `0002.png`, etc. HTTP failures,
unsupported data (including HTML challenges), permission refusal, and interrupted
downloads are reported. No partial CBZ is exported after an image fetch failure.
Success is reported only when Firefox reports a completed download.

Requests use the normal browser session where Firefox permits it. No cookies,
tokens, or credentials are read or extracted. Fetching images and previews contacts
their original servers; the extension does not transmit them to another service.
All capture state is held in memory, not storage.sync or an external database.
The complete archive is assembled in memory, which limits very large chapters.

## Permissions

- `activeTab`: access to the tab explicitly selected through the extension action.
- `scripting`: inject the capture script into that tab.
- `downloads`: save the CBZ and observe completion/interruption.
- Optional HTTP(S) host permissions: requested only for selected image origins
  when exporting, rather than granting access to every site at installation.
  Granted permissions remain in Firefox until revoked in the add-on settings.

## Known limits

- Single-document capture only. Reloads and full page navigation reset it.
  Paginated readers that replace the document are not yet supported.
- Detection covers ordinary top-level `img` elements, not iframe contents,
  CSS backgrounds, canvas, blob URLs, or encrypted media.
- DOM order may differ from reading order on recycled/paginated readers.
  Review and manual ordering are required; no site compatibility is claimed.
- Deduplication uses exact URLs, not image content. Different URLs with identical
  bytes remain separate; repeated use of one URL becomes one entry.
- Refetching can fail due to access restrictions, expired URLs, or browser cookie
  rules. The bytes returned on export can differ from an earlier server response.
- Preview images may be unavailable even when an export request would succeed.
- Closing the review tab stops its export. Closing Firefox loses capture state.
- No scrolling/navigation automation or access-control bypass.

## Implementation and validation

- `src/content.ts`: scoped, idempotent injection, viewport observation and review state.
- `src/popup.ts`: popup/review controls and source-document validation.
- `src/export.ts`: signature checks, filename sanitation and CBZ saving.
- `scripts/build.mjs`: staged packaging and local JSZip bundling. The bundled
  setImmediate shim rejects string callbacks to comply with extension CSP;
  builds fail if the expected vendor shim changes. A regression test runs this
  bundle with dynamic code generation disabled.
- `tests/core.test.cjs`: delayed loading/order, exclusions, reinjection, DOM
  replacement, signatures, filenames, exact ZIP bytes and failed downloads.

web-ext was upgraded to 10.8.0. The last dependency audit still reported three
low-severity findings in its development-only deepmerge/addons-linter chain.
No high/critical findings remained. Do not use audit fix --force to downgrade
web-ext to an obsolete release.

Before claiming compatibility, manually test authorized content in Firefox:
lazy loading, short strips, source replacement, exclusions across popup reopening,
manual ordering, host permission refusal/grant, a blocked image, saving/cancelling,
and source-tab navigation. Verify exported order and bytes in a standard CBZ reader.
The example sites in AGENTS.md have not yet been validated.
