# Webtoon to CBZ — v0.1 prototype

Project handoff: [conversation summary and remaining Firefox checks](docs/CHAT_SUMMARY_2026-11-12.md).

Firefox-first extension for archiving images you are authorized to save. Captures
image URLs while you read, offers review and ordering, and exports an ordinary ZIP
with a .cbz extension. Available original bytes are preserved; PNG pixel fallbacks
and user-requested merges are explicitly labelled as re-encoded. No telemetry,
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
2. Choose whether to allow **Automatic PNG fallback** and **Automatic continuation**,
   then click **Start new capture**. Automatic continuation requests access to this
   site's origin when needed, so capture can resume after a full document change.
   This replaces the previous capture for that tab. The checked fallback option
   permits re-encoding displayed pixels if original blob bytes are not ready when
   the PNG safety copy finishes. Fast original reads still win without conversion.
3. Read/scroll/use the reader arrows normally. Capture continues after the popup
   closes and resumes after page changes in this tab. Following chapters on the
   same authorized origin are appended to the same capture and exported together.
4. Click **Stop**, then **Open review and export tab**.
5. Check that every chapter page is present. Exclude ads, move pages with
   **Up/Down**, and enter a filename such as `Series - 0280`.
6. Export. Firefox asks for access to the image server origins when needed.
   Keep the review tab open until saving completes. The popup may close freely.

The list, exclusions, title, manual ordering and recovered blob bytes are saved in
extension-origin IndexedDB, never in site storage or storage.sync. They remain
reviewable/exportable after source navigation or reload. Wait until local image
saving completes before leaving; data not recovered and saved beforehand cannot
be recreated after navigation. Storage failures are shown in the popup/review.
**PNG re-encoded** describes image format, not a completed save. Wait for the
separate **Saved locally** confirmation (and zero not-yet-saved images) before
leaving a document. Each image is acknowledged only after IndexedDB verifies all
its chunks and commits a completion marker. A stale metadata checkpoint cannot
undo that acknowledgement. Failed writes remain errors and never count as saved.
**Stop** waits for current image/save tasks and returns their confirmed status.
Firefox is asked to warn before full navigation/reload while work is pending;
this does not intercept the reader's arrows when they only replace a DOM image.

To repair an older incomplete Scan-Manga capture, return to its image with the
reader arrows and enable Automatic continuation if capture is stopped. A loaded page
whose advertised slot is already known is rebound to its new image node/blob and
retried if its archived bytes are missing. The original row/order/exclusion are
retained rather than adding duplicates. Refresh the review after **Saved locally**.
Starting a new capture instead discards the old list and is not needed for repair.

**Automatic continuation** replaces the manual Continue button. After a complete
page load, the background coordinator injects capture only into that tab, checks
that the permission/session are still valid, and restores the same capture
generation. The PNG fallback choice and review metadata are preserved. Reader
arrows that replace DOM images continue under the existing observer without
restarting capture. Reloading is supported, too. The extension never clicks arrows,
scrolls automatically, loads a URL, or navigates the user to another page.

Following chapters are included in the same CBZ, as requested. On Scan-Manga,
page slots are keyed by chapter identity plus page number: chapter 2 page 1 cannot
replace chapter 1 page 1. Chapter order and advertised missing-page counts survive
navigation, and leftover old reader nodes are ignored during a chapter transition.
Other origins and tabs are excluded. Automatic recovery on a live site still
requires Firefox validation; fixtures cover the event/storage flows.

Known challenge pages and missing Scan-Manga reader containers pause capture.
The content script observes readiness and rechecks authorization before resuming
after the user completes verification. It does not solve or interact with a
challenge. **Stop** disables automatic continuation durably, including when the
source document is gone. To resume an existing capture, check Automatic continuation
again; no new Start is required. Denying/revoking site access leaves full-navigation
recovery off/paused, while already saved images remain available.

Use **Start new capture** for a separate chapter; it removes the previous tab's
saved payloads. Incomplete previous documents remain reported as missing.
The saved capture belongs to its source tab identifier for the current Firefox
session; a full Firefox restart clears it to prevent tab-identifier collisions.
Review-only edits such as merges and numbering still live in the review tab.

## File information and JPEG export

Enable **Show file formats and average size** in the popup or review tab to display
each file's detected format and byte size, plus format counts, arithmetic mean and
total for included images. Sizes are file bytes (KiB/MiB), not pixel dimensions or
thumbnail sizes. Excluded images do not affect the mean. Partial coverage is
explicitly labelled, for example 12/36 measured; unknown files are not counted as
zero. The popup uses captured metadata alongside its thumbnail cache, so displaying
statistics does not force full image transfers on reopening.

Formats are signature-checked. Blob captures record metadata locally during save,
and review merges use their new output bytes. Remote HTTP(S) files or older
captures may initially have unknown metadata. In review, **Measure selected files
(pauses capture)** requests the needed image-server access and reads unknown
selected files. Failures remain visible and the average stays partial. URL suffixes
are never used to guess file type or size.

In the review tab, enable **Export as JPEG — quality 97, 4:4:4** to use this fixed
conversion profile while building the CBZ. It is off by default. Every selected
file is re-encoded, including existing JPEGs, so original 4:2:0/4:2:2 sampling cannot
silently survive the conversion option. Leaving conversion off preserves captured
file bytes. PNG/WebP/AVIF/GIF/JPEG inputs are decoded locally at native dimensions,
without scaling/cropping. Transparency is composited over white and animated inputs
produce one decoded frame. JPEG remains lossy and does not preserve source metadata;
re-encoding cannot recover detail already lost in the source.

Canvas is used only to obtain opaque RGBA pixels, not to encode JPEG: the browser
does not expose explicit chroma-subsampling control. The locally bundled encoder
from **jpeg-js 0.4.4** runs in a dedicated worker at quality **97** on that encoder's
scale. Its Y/Cb/Cr components use 1×1 sampling, meaning **4:4:4**. The extension
verifies the actual output SOF frame sampling and dimensions before adding a file
to the CBZ, failing export if they differ. Tests run the real packaged encoder with
dynamic code generation disabled, compare output against quality-97 reference bytes,
inspect sampling factors, and decode output files. Encoder source/license are
retained in the packaged jpeg-encoder.js; only the encoder is loaded, not its decoder.
Reference: [jpeg-js source](https://github.com/jpeg-js/jpeg-js/blob/master/lib/encoder.js).

The captured source files, preview cache and merge undo data are not replaced by
JPEG output. Unchecking the option restores the ordinary format-preserving export.
Conversion/decode/Canvas failures abort export, rather than dropping pages or merely
renaming file extensions. The existing Canvas limits apply (32767 pixels per side,
64 megapixels). Each bitmap/Canvas is released before worker encoding; RGBA is
transferred rather than copied, and each worker is terminated after success/failure.
The worker has a two-minute limit per image. Pure JavaScript encoding can be slower
and larger than native Canvas JPEG, but does not block the review UI thread.
The optional info
panel reports actual mean/total image bytes for the last successful export, separate
from the current source-file statistics; ZIP container overhead is excluded.

### Optional ImageMagick encoder on Windows

JPEG conversion offers two engines and an automatic choice:

- **Automatic (ImageMagick if connected)**: try the native connector; use the built-in
  worker when unavailable or if conversion/profile validation fails. After a failure,
  the remaining files in that export use the built-in engine without retrying the host.
- **Built-in**: always use the local jpeg-js worker; no external installation is needed.
- **ImageMagick (required)**: use the native engine or abort with an explicit error.

Both engines use quality 97, 4:4:4, unchanged dimensions and white compositing.
Outputs are not expected to be byte-identical or have equal sizes. The actual engine
used appears after export, including mixed native/built-in output after a fallback.

Installing ImageMagick alone does not expose it to Firefox. Install the small
project-specific Native Messaging connector once, from the project directory:

```powershell
npm run native:install -- --dry-run
npm run native:install
```

This requires Windows, Node.js 20+ and ImageMagick 7 on PATH. To select an executable:

```powershell
npm run native:install -- --magick "C:\Program Files\ImageMagick-7.1.2-Q16-HDRI\magick.exe"
```

The installer copies the host to `%LOCALAPPDATA%\WebtoonToCBZ\ImageMagickHost` and
registers only `HKCU\Software\Mozilla\NativeMessagingHosts\webtoon_to_cbz.imagemagick`.
It pins absolute Node/ImageMagick paths, requires no administrator privileges and
allows only extension ID `webtoon-to-cbz@example.local`. No resident service is
installed. A conflicting registration is not overwritten. Dry-run changes nothing.

Reload the extension, open review, choose JPEG conversion, click **Check ImageMagick**
and grant the optional **nativeMessaging** permission. This check confirms the
connector, not merely that magick.exe exists. Automatic mode can safely remain on
without this permission/connector; it then uses the built-in engine. Explicit
ImageMagick mode reports missing setup instead of silently changing engines.

```powershell
npm run test:native
npm run native:uninstall
```

`test:native` checks the real executable's quality/sampling using ImageMagick identify,
as well as the native stdio protocol; it skips executable tests when ImageMagick is
not installed. The native connector has been exercised through its real process
protocol locally; Firefox-to-host integration still needs manual validation.

Only RGBA pixels and dimensions cross this local connection. The fixed native
protocol accepts no URLs, input/output paths, shell commands or arbitrary options.
ImageMagick is spawned with an argv array, shell disabled and hidden Windows
processes. The fixed profile is `-quality 97 -sampling-factor 1x1,1x1,1x1 -interlace none`.
Input is raw RGBA on stdin and JPEG is returned on stdout in bounded base64 chunks
below Firefox's native response limit. No image upload or explicit image temp files
are used. Limits: 64 megapixels / 32767 pixels per side, 128 MiB output, two minutes
per conversion, bounded ImageMagick pixel-cache resources. A host is disconnected
after each image/check, and subprocesses are stopped on disconnect. The preview
cache/source archive are unaffected by native encoding.

References: [Mozilla Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging),
[ImageMagick options](https://imagemagick.org/command-line-options/).

## Manual vertical merging

### Automatic ratio analysis

Click **Analyze automatically** to prepare the whole chapter in one pass, then
**Merge numbered pages** to apply every suggested group together. This avoids
repeating the height-based workflow for different page sizes. Analysis uses captured
dimensions locally; it does not fetch, convert, merge, or delete images. It replaces
current number assignments and disables nonmatching images, preserving manual exclusions.

The reference height/width ratio is estimated from at least two similar included
portrait pages, including existing merges. **Reference ratio (height / width)** can
override it (for example, width 1000 and height 1500 gives 1.5). No chapter height or
ratio is predefined. If there are no reliable complete pages, analysis leaves edits
unchanged and requests a reference ratio. **Ratio tolerance (%)** defaults to 10%
and is adjustable from 0 to 20%; it is independent of height tolerance.

Included full pages matching the reference stay separate. Other images are tested
as consecutive strips whose total height divided by maximum width matches the
reference. Group widths must agree within 5%; the closest ratio is preferred.
Different widths therefore produce different target heights automatically.
The existing **Minimum image width** field, when filled, is applied in the same
analysis. Narrower incompatible previews between strips may be excluded so they
do not interrupt a group. Existing merges and explicitly restored exceptions are
protected, and unknown dimensions remain included for manual review. Canvas limits
are checked before proposing a group.

**Review excluded (N)** shows only excluded images, with dimensions, reasons and
**Preview**. **Restore as page** re-enables an exceptional double page with its own
number and protects it during later automatic analyses. **Back to pages** returns
to the main view. The ordinary inclusion checkbox can instead restore strips for
manual numbering without protecting them from future automatic classification.
Exclusions are retained in source capture state; notes, numbering and exception
protection live only in the review tab and survive its toolbar refresh.

This is a geometric heuristic, not a content or page-boundary detector. It can
exclude legitimate wide pages, mistake matching-ratio previews for real pages,
or join strips at the wrong boundary. Check the groups and every exclusion before
merging/exporting. A missing strip or unusually long webtoon segment may need manual
handling. A complete low-resolution page with the correct ratio is retained unless
the user supplies a minimum width. Nothing is silently removed from the review.

### Manual controls

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

Same-origin `blob:` image URLs are also captured. Their bytes are read in the
source content script as soon as the loaded image is encountered during reading,
so later URL revocation does not require refetching the image. The review tab
uses cached thumbnails; it reads full originals on demand for full-size previews,
analysis, merging or export. Unmerged bytes are exported unchanged by default.
The 420-pixel-wide popup displays local previews directly (70 by 90 pixels).
After each saved blob image, a background queue creates a PNG thumbnail bounded
to 140 by 180 pixels. Popup and review fetch available thumbnails in one request;
reopening does not transfer or decode the originals. Thumbnail loading never locks
the export/review commands. Individual files still must be available for export.

Open **Background JPEG preparation** in the popup and enable **Prepare JPEG 97 /
4:4:4 while reading** before or during capture. Choose Automatic, Built-in or
ImageMagick; use **Check ImageMagick** in review to grant connector access first.
The review JPEG checkbox controls the same capture-scoped preparation setting.
This option is off by default. Already saved blob images are queued too, and the
setting survives automatic chapter continuation. HTTP-only images not saved in the
capture are still fetched/converted during export with the existing permissions.

Preparation runs one job at a time, yields between jobs, and keeps originals
independent of derived assets. JPEGs are persisted as local IndexedDB Blobs, keyed
by capture, source and encoder/profile. Export reuses prepared JPEGs and prioritizes
needed conversion jobs over queued previews; unfinished conversions may still
require waiting. Changes to order or inclusion do not invalidate existing images.
A merged image has its own source identity and is converted separately; undo can
reuse the original strips' prepared files. Background status reports pending jobs
and failures; failed conversions are retried when exporting. Opening or refreshing
the UI reconstructs missing preparation jobs after a background-page restart.

Start new capture cancels old jobs and deletes that tab's originals and derived
assets. Successful export clears derived thumbnails only, retaining originals,
prepared JPEGs and review edits for undo/re-export. Failed/cancelled downloads do
not clear the cache. A version prevents stale thumbnail writes after clearing.
Missing thumbnails are regenerated on reopening. All capture data remains local.
No source blob URL is opened from the extension origin. Temporary full-image
preview URLs are released when the UI closes. Save only authorized images.

Recovered blob bytes are also saved in bounded IndexedDB chunks. The source tab
is needed while reading/capturing pixels, but saved bytes remain available after
its document changes or closes. Keep the review tab open until export completes;
review object URLs are released when no longer used.
Source transport reads byte indices directly rather than using typed-array
subarray/slice operations: Firefox compartment wrappers can deny access to their
constructor/species, particularly for Canvas-produced data. No image re-encoding
is performed during this transfer.

If Firefox cannot read the blob from the isolated content-script context, the
background script performs a fallback read in the source page's MAIN execution
world. It accepts requests only from this extension's top-frame capture script,
checks the blob origin and requires a matching, loaded image in that document.
It invokes no site functions, reads no page variables, and does not intercept URL
creation or revocation. The page can influence MAIN-world results, so responses
are bounded (64 MiB per image), checked during transport, and signature-validated
before preview/export. This fallback preserves the original returned image bytes;
it does not reconstruct pixels through canvas. Failed reads are retried when the
review requests data again, including when the reader replaced the image URL.
Successful bytes remain cached. A URL revoked before either read succeeds remains
unavailable; the error now includes the underlying cause instead of hiding it.

Loaded-image events are scanned immediately during the capture phase, rather than
waiting for the next animation frame, so a target load handler has less opportunity
to revoke the URL before the byte request begins. This cannot restore an URL that
was already revoked before Start.

For an unreadable blob that remains loaded in the source document, the review row
offers **Use displayed pixels (PNG)**. This is an explicit, per-image action.
If **Automatic PNG fallback** was enabled at Start or when enabling continuation, a provisional PNG
copy is drawn immediately when a loaded blob image is detected, before waiting
for any asynchronous original-byte read. Thus a reader arrow can replace/remove
the image without changing the frozen pixels. This copy is selected and archived
as soon as it is ready if the original-byte read is still pending or has failed.
An already-ready original is preferred, with one event-loop turn of grace for a
fast original response. A blocked original therefore cannot postpone saving a
finished PNG until its 30-second timeout. The chosen result is immutable: a late
original does not replace a PNG while chunks are transferred or after commit.
Fast successful originals discard the provisional copy and remain unchanged.
This extra Canvas work may increase CPU/memory use.
Uncheck the option before Start/enabling continuation to require manual conversion. Available
original bytes take precedence when ready first. It draws the loaded, same-origin image at its native
dimensions onto Canvas and encodes PNG, without cropping/resizing. The preview and
CBZ then use those PNG bytes, and the row permanently labels the re-encoding.
Original compressed bytes, metadata and animation are not preserved by this mode;
the browser's current decoded image/frame is used. Original cached files are never
replaced by this action. Canvas origin-clean checks and memory limits remain in
force, and failures leave the original error intact. Keep the source image loaded;
manual fallback cannot capture an image already removed. An automatic safety copy
made before removal can still finish while the same document remains alive.
Full navigation before the chosen bytes finish saving can still interrupt capture.
When automatic continuation restores old entries, their binary chunks are read from the extension
archive rather than assuming they are present in the new document's memory cache.

A narrowly scoped Scan-Manga adapter recognizes `#container.img_lel[data-nbpage]`
on scan-manga.com and www.scan-manga.com. It captures only images in that reader,
orders them by their enclosing `data-page`, and avoids duplicate entries if the
reader replaces a captured page with a fresh blob URL. The advertised page count
also detects unloaded/unread slots: two captured pages out of twelve report ten
missing, and export is blocked until all pages have been encountered. Start capture
before reading and scroll normally through every page. No placeholder is downloaded
or advanced automatically. Toolbar Refresh imports newly captured pages and bytes.

These behaviors are covered by regression fixtures reproducing the supplied
Scan-Manga DOM; live integration on that site still requires Firefox validation.
If a blob was revoked before its bytes could be read, or its media type is not
supported, the review reports the error and refuses to export that included image.
Reload the chapter and start capture before reading if necessary. No site-provided
functions are invoked and no encryption, challenges or access controls are bypassed.

There is no minimum width/height filter: short or narrow strips remain reviewable.
This also means icons and ads can appear and must be excluded manually. Broken or
pending images encountered during reading are counted and block export. Load them
and recapture before exporting. This cannot detect chapter pages the site never
inserted or the user never reached; manually verify completeness.

## Export and data flow

For HTTP(S) URLs, the review tab fetches selected URLs sequentially, with a 30-second response
timeout per image, and checks JPEG, PNG, GIF, WebP, or AVIF signatures. By default it preserves
the returned bytes and names entries `0001.jpg`, `0002.png`, etc. HTTP failures,
unsupported data (including HTML challenges), permission refusal, and interrupted
downloads are reported. No partial CBZ is exported after an image fetch failure.
Success is reported only when Firefox reports a completed download. Cached blob
images use the same signature validation and naming without HTTP host requests.

Requests use the normal browser session where Firefox permits it. No cookies,
tokens, or credentials are read or extracted. Fetching images and previews contacts
their original servers; the extension does not transmit them to another service.
Capture metadata and recovered blob data use local extension IndexedDB. HTTP(S)
entries currently retain URLs and are refetched during export; unavailable remote
URLs still fail explicitly. No data is uploaded or synced. Review merges and the
complete CBZ are assembled in memory, which limits very large chapters.

## Permissions

- `activeTab`: access to the tab explicitly selected through the extension action.
- `scripting`: inject the capture script into that tab.
- `downloads`: save the CBZ and observe completion/interruption.
- Optional `nativeMessaging`: only for the user-installed local ImageMagick connector.
  Requested by Check ImageMagick; ordinary built-in conversion does not require it.
- Optional HTTP(S) host permissions: automatic continuation requests the current
  reader's origin at Start/enabling the checkbox. Export/merge may request the
  selected image server origins separately. No global host access is required.
  Granted permissions remain in Firefox until revoked in the add-on settings.

## Known limits

- Full-navigation recovery requires Automatic continuation and granted site access.
  It runs after document loading, so leaving again before capture/save finishes can
  still lose unrecorded data. Cross-page operation has regression coverage but
  still needs real Firefox testing. The same-origin limit excludes cross-domain redirects.
- Detection covers top-level `img` elements with HTTP(S) or readable same-origin
  blob URLs, not iframe contents, CSS backgrounds, canvas or encrypted media.
- Original bytes of blobs already revoked before capture cannot be recovered;
  the optional displayed-pixels PNG action may still work for loaded images. Supported image
  signatures are JPEG, PNG, GIF, WebP and AVIF; other blob formats fail explicitly.
- DOM order may differ from reading order on recycled/paginated readers.
  Review and manual ordering are required; no site compatibility is claimed.
- Deduplication uses exact URLs, not image content. Different URLs with identical
  bytes remain separate; repeated use of one URL becomes one entry.
- Refetching can fail due to access restrictions, expired URLs, or browser cookie
  rules. The bytes returned on export can differ from an earlier server response.
- Preview images may be unavailable even when an export request would succeed.
- Closing the review tab stops its export. A full Firefox restart clears saved captures.
- No scrolling/navigation automation or access-control bypass.

## Implementation and validation

- `src/content.ts`: scoped, idempotent injection, viewport observation and review state.
- `src/background.ts`: validates source requests and performs the displayed-blob
  fallback in the source page context when isolated reads fail.
- `src/processing.ts`: serial background thumbnail/JPEG preparation and persistent derivative caches.
- `src/capturedBlobs.ts`: bounded transport of cached source image bytes to review.
- `src/captureStore.ts`: transactional local checkpoints and archived image chunks,
  with generation checks and review access after source navigation.
- `src/navigation.ts`: per-tab automatic continuation, persisted enable/stop policy,
  permission checks and background navigation listeners.
- `src/navigationScope.ts`: shared origin/chapter identity checks and pagination normalization.
- `src/popup.ts`: popup/review controls and source-document validation.
- `src/export.ts`: signature checks, filename sanitation and CBZ saving.
- `src/imageInfo.ts`: shared signature detection and file-size statistics, also
  used for durable capture metadata without loading full images in the popup.
- `src/jpegEncoder.ts` and `src/jpegWorker.ts`: local JPEG quality-97 / 4:4:4
  worker encoding, output-frame verification and cleanup.
- `src/imageMagick.ts` and `native-host/`: optional local native encoding, explicit
  mode selection, Automatic fallback, bounded IPC, and per-user Windows setup.
- `src/imageMerger.ts`: Canvas merging and reversible source retention.
- `src/pageGrouping.ts`: native border inspection, numbering suggestions and group validation.
- `src/autoGrouping.ts`: automatic ratio-based grouping and reviewable exclusion planning.
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


### Starting over and capture warnings

Start new capture replaces the current source tab's capture generation, saved
images, derived thumbnails/JPEGs, exclusions and ordering. Stalled old storage
or preview requests cannot block the new generation. If the source script is
unavailable or local reset fails, the UI reports the failure instead of showing
an archived session as a successful new capture. Firefox does not need restarting.

A dedicated red warning reports failed image capture/saving for images still
connected to the current document. When automatic PNG recovery is enabled, it
explicitly warns that recovery did not produce a saved image. Keep the chapter
open and retry; unloaded/unread chapter pages remain a separate completeness
warning. The warning refreshes while the capture UI is open and clears when the
failed image leaves the current document or is recovered.

Firefox toolbar popups are capped at 600 CSS pixels in height. Capture/conversion
settings are collapsible and the preview list reserves 150 pixels. Use **Open
taller capture window** for a resizable, 470-by-900-pixel requested window bound
to the same source tab. The desktop/window manager may constrain its actual size.
This window shares the same local capture and does not start another session.
