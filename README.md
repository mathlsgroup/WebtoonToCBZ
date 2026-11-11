# Webtoon to CBZ — v0.1 prototype

Firefox-first extension for archiving images you are authorized to save. Captures
image URLs while you read, offers review and ordering, and exports an ordinary ZIP
with a .cbz extension. Unmerged images retain their original bytes. No telemetry,
accounts, or external services.

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

## Manual vertical merging

The review toolbar stays visible while scrolling. Each image has an editable
**Page number** column. Give consecutive included strips the same number, then
click **Merge numbered pages** to apply all groups at once. Number labels do not
sort the list: the current reading order remains authoritative, and CBZ filenames
are numbered sequentially. Excluded images between strips are ignored by both
numbered and checkbox merging; an included image belonging to another page still
interrupts the group. Pending groups must be merged or assigned separate numbers
before export. Uncheck unwanted next-chapter previews, then use **Hide excluded
images** to hide them without deleting them. Uncheck this option to show them again
and restore inclusion if needed. No images are excluded automatically by resolution.

To exclude low-resolution previews in one action, enter **Minimum image width (px)**
and click **Exclude narrower images** before suggesting page numbers. The field is
initially blank. Only included images with a known width strictly below the threshold
are disabled; equal-width images and images with unknown dimensions are retained.
For example, a minimum of 321 px excludes 320 px thumbnails. This uses captured
dimensions without fetching or converting images. Exclusions survive toolbar refresh
and are ignored by grouping/export. Use **Hide excluded images** to hide them; show
them again and use their inclusion checkbox to restore any legitimate narrow strips.
Changing the threshold does not re-enable previous exclusions. Apply it again after
capturing new images if needed.

**Suggest page numbers** downloads/decodes included images locally, then proposes
numbers without merging. It replaces current assignments, so run it before making
manual corrections. It looks for consecutive landscape strips starting with a
white top border and ending with a white bottom border, whose combined height is
greater than their maximum width. Widths must agree within 5%. The final height/width
ratio must also be within 20% of the median ratio of included complete portrait
pages (including already merged pages). At least two such reference pages are
required, with at least two thirds of them within 20% of that median. Excluded
previews do not contribute to the reference. When references are missing or
inconsistent, candidate strips remain separate with an explanation; manual numbering
and merging remain available without a ratio restriction.

Portrait pages and already merged pages stay separate. Excluded images are skipped
throughout detection; unavailable included images, new white top borders and included
portrait pages interrupt a candidate group.

If border-based suggestions fail, enter **Target page height (px)** (initially blank;
there is no predefined height) and click
**Suggest by height**. For example, five 302 px strips plus one 303 px strip total
1813 px. This separate fallback replaces the current numbering using captured
dimensions, without fetching images, checking white borders or requiring reference
portrait pages. It proposes groups only; inspect the numbers and then click
**Merge numbered pages**. Existing merges and images already at the target height
remain separate. Included images are processed in reading order; excluded images
are skipped. Group widths must agree within 5%. Summed heights must fall within the chosen
**Tolerance (%)**, default 1%, adjustable from 0 to 10% (0 requires an exact match).
When several totals fit, the closest to the target is preferred; ties use fewer strips.
The row note shows the actual proposed height. Images already near the target remain separate. Nothing is resized, cropped or padded to reach the requested height.

Incomplete groups, invalid dimensions and groups outside the tolerance stay
separate with a note. The search resumes at the next included image, so an unmatched
strip does not prevent later matches. This can still propose incorrect boundaries
when starting midway through a page: verify alignment visually before merging.
Height must be a whole number from 1 to 32767; Canvas memory limits still apply
when the proposed groups are merged. This mode also replaces manual assignments.

The detector inspects the first/last three native pixel rows. One row with at least
98% near-white pixels (RGB channels at least 245, composited over white) counts as
a border. This tolerates slight JPEG noise but remains a heuristic: blank artwork,
internal white gutters or borderless pages can produce wrong or missing groups.
Check the suggestions and row notes, correct numbers manually, and then merge.
Failed analyses stay separate with an error note; no image is removed. Cached
source bytes are reused for merging/export without modifying them.

Batch merging is transactional: if any group fails, the current list is retained
and provisional merged images are released. Each successful group can be undone
independently, restoring its original numbering, image bytes and the original slots
of interleaved excluded rows that are still present. After undo, use
different numbers if the restored strips should be exported separately. Numbering,
like merges, exists only in the current review tab. No new permissions are added.

In the review tab, use the **Merge** checkboxes to select at least two consecutive,
included pages, then click **Merge vertically**. These checkboxes are separate from
the inclusion checkboxes. Nothing is merged automatically. Use **Preview** to inspect
the full result. Narrower strips are centered on white without resizing or cropping.
All-JPEG selections produce JPEG at quality 0.95; other combinations produce PNG.
Animated inputs are flattened to the frame decoded by the browser.

Each merged row has **Undo merge**; the toolbar restores the latest visible merge.
Independent and nested merges retain their sources and can be undone even after
selection or ordering changes. Export uses the current included pages in review order.
Original bytes fetched for merging remain cached for undo/export. Other pages are
fetched normally and are never re-encoded. Image-server access may be requested at merge time.

Merges and their cached bytes live only in the current review tab. Refresh with the
toolbar preserves them; reloading/closing that tab loses them. Start a new capture
to discard all edits. The canvas is limited to 32767 pixels per side and 64 megapixels
as a conservative memory budget; Firefox may impose lower limits. Allocation,
decoding and encoding failures are reported without replacing the selected pages.
Large merges can briefly occupy the UI thread and use substantial memory.

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
- `src/imageMerger.ts`: Canvas merging and reversible source retention.
- `src/pageGrouping.ts`: native border inspection, numbering suggestions and group validation.
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
