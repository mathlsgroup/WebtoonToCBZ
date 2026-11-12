# Conversation summary — 2026-11-12

This document summarizes the available conversation, user decisions, reported
failures and work reported as completed. It is a handoff record, not a verbatim
transcript or a certification of site compatibility. Follow `AGENTS.md` for
subsequent work. Technical documentation is in English; discuss with the user in
French.

For the separate thread covering manual merging, page-number suggestions,
height/ratio grouping, reversible exclusions, the Git conflict incident and the
initial Scan-Manga blob diagnosis, see
[the image-merging conversation summary](CHAT_SUMMARY_IMAGE_MERGING_2026-11-12.md).

## Purpose and workflow

WebtoonToCBZ is a Firefox-first extension for saving images the user is authorized
to archive into an ordered CBZ. The requested workflow is Start, read normally,
Stop, review/exclude/reorder, then export. Preserve original formats and bytes
where possible. Use zero-padded ZIP entry names and retain reading order regardless
of asynchronous processing. Keep data local and do not bypass access controls or
human verification.

The conversation began with a request to review the v0.1 architecture,
dependencies and compilation under `AGENTS.md`, followed by requests to fix the
issues, explain Firefox testing and supply build commands. Milestone labels do
not establish that a feature or site has been validated.

## Capture failures and persistence

The user reported detected images with blank previews and an unusable CBZ.
Their concrete test chapter was:

https://www.scan-manga.com/lecture-en-ligne/Yaoshenji-Tales-of-Demons-and-Gods-TODAG-Chapitre-3245-FR_216463.html

Reported errors included:

- Displayed image blobs could not be read.
- Page-context fetch failed with `NetworkError`; URLs could already be revoked.
- Explicit displayed-pixels recovery initially encountered Firefox's
  `Permission denied to access property "constructor"` error.
- Navigation produced `Image was not captured in this document` or
  `Image data was not saved before navigation`.

The user navigates using the reader's arrow buttons, including between chapters.
They confirmed that displayed-pixels recovery eventually made images visible.

The resulting implementation reads available original bytes promptly and can
capture displayed pixels as a PNG fallback. This is explicitly re-encoded data,
not the original file. Original reads and the optional PNG safety copy race so a
ready PNG is not held behind an unavailable original. Firefox messaging uses
bounded chunks. Captured data is persisted in extension IndexedDB so source
navigation and popup closure do not discard saved images. Persistence, exclusions,
ordering and export completeness must remain distinct from preview readiness.

## Automatic continuation

The user asked to replace the manual "Continue on this page" action because they
might forget it. They explicitly chose continuation across subsequent chapters,
not just pages of the current chapter.

Automatic continuation is scoped to the source tab and authorized site. It
requires the relevant site access, resumes capture after supported navigation,
and retains chapter/page ordering. Stop disables continuation. This observes
normal user navigation; it does not automatically solve challenges or traverse
the site. The user completes human verification themselves.

## Popup, previews and caching

Repeated requests concerned making the review/export action visible, reducing
popup width, showing actual previews and speeding up reopening.

The implementation uses a narrow popup, a scrolling image list and a separate
review/export tab. Derived PNG thumbnails are stored locally and reused by both
popup and review. Full source bytes are read on demand for full-size previews,
analysis, merging or export. Thumbnails are a visual check and must not block
export commands. An export must still fail explicitly when required image data
is unavailable.

## File information and JPEG conversion

The user requested optional file-type and average-size information, then specified
the exact optional JPEG profile: **quality 97 with 4:4:4 subsampling**. This does
not replace the default format-preserving export.

The user installed ImageMagick and requested two conversion paths:

- A built-in local JPEG encoder requiring no ImageMagick installation.
- ImageMagick through an optional local Firefox native-messaging connector.

Automatic mode uses ImageMagick when connected and falls back to the built-in
encoder. Required ImageMagick mode reports failure instead of silently changing
engines. JPEG output sampling and dimensions are checked. Native dimensions are
retained, transparency becomes white, and conversion is lossy. Installing
ImageMagick alone does not register the Firefox connector; the project provides
installation/check commands and documentation.

The user later reported that everything worked but conversion was too slow.
They approved background preparation during reading. The resulting serial
background queue prepares thumbnails after saved blob captures and, when enabled,
JPEG 97/4:4:4 derivatives. Prepared JPEGs are cached by capture, source and encoder
profile and reused at export. Export-needed conversions receive priority over
queued previews. HTTP-only images not saved in the capture still need fetching
and conversion during export. Merged images are separate outputs; source-strip
caches remain usable after undo. Background status exposes pending work/errors.

Start replaces the old capture and derived caches. Successful export currently
clears derived thumbnails while retaining original data, prepared JPEGs and
review edits for undo or another export. Failed/cancelled downloads preserve the
cache. A generation/version check prevents late writes from reviving stale data.

## Latest failure report and changes

The user reported needing to close Firefox to reset, insufficient image-list
height, and a need for an explicit warning when PNG recovery fails on the current
page. The latest changes addressed:

1. A new capture generation no longer waits behind a stalled old storage queue.
2. Old in-flight thumbnail reads cannot block previews for a new generation.
3. Start cannot fall back to an archived session and present it as a successful
   new capture when the source script is unavailable. Reset/storage errors are
   reported.
4. Start prevents overlapping starts and restores controls when finished.
5. Capture/conversion options are collapsible and the image list reserves visible
   space. Firefox limits toolbar popups to 600 CSS pixels in height, so an
   **Open taller capture window** action requests a separate, resizable
   470-by-900 window bound to the same source tab.
6. A dedicated red warning reports capture/save failures for images still
   connected to the current page. With automatic PNG recovery enabled, it says
   that recovery did not produce a saved image. It refreshes while the capture UI
   is open. Historical failures and unread chapter pages are separate concerns.

Mozilla's popup sizing documentation:
https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups

## Implementation landmarks

- `src/content.ts`: detection, reader slots, original/PNG capture, source state.
- `src/captureStore.ts`: local IndexedDB capture sessions, chunked image payloads
  and thumbnail lifecycle.
- `src/navigationScope.ts` and `src/navigation.ts`: continuation policy and
  supported navigation handling.
- `src/processing.ts`: background preparation and persistent derivative caches.
- `src/capturedBlobs.ts`: bounded image transport and thumbnail helpers.
- `src/popup.ts`, `popup.html`, `popup.css`, `review.html`: controls, review,
  previews, warnings and export orchestration.
- `src/export.ts`, `src/jpegEncoder.ts`, `src/jpegWorker.ts`,
  `src/imageMagick.ts`: CBZ and optional fixed-profile JPEG export.
- `native-host/`: optional ImageMagick connector and installer.
- `tests/core.test.cjs` and `tests/native.test.cjs`: automated checks.

## Commands and verification record

Run from the project directory:

```powershell
npm install
npm run build
npm run lint
npm test
npm run check:extension
npm run test:native
```

Optional native connector commands:

```powershell
npm run native:install
npm run native:uninstall
```

The latest completed implementation turn reported **110 passing core tests**,
a successful build/type check, and extension validation without errors, notices
or warnings. An earlier turn also ran **3 passing native tests**, including real
ImageMagick encoding. Those results describe their respective runs; this
documentation-only summary does not rerun them. Dependencies include TypeScript,
WebExtensions tooling, JSZip, jpeg-js and fake-indexeddb; consult `package.json`
and the lockfile for current versions.

## Next manual Firefox checks

1. Rebuild if needed. In `about:debugging`, load `dist/manifest.json` as a temporary
   extension or reload its existing entry. Refresh the chapter after script
   changes; closing/reopening Firefox is not required.
2. Start a capture, read several pages/chapters using the site's arrows, reopen
   the popup and verify saved images, exclusions and reading order.
3. Start another capture without restarting Firefox. Confirm old images,
   exclusions, ordering and derived results are replaced. A chapter's unread-page
   count can legitimately be nonzero in a fresh capture.
4. Compare the compact popup and taller capture window, including expanded
   settings, warnings and access to review/export.
5. On an actual image-read/PNG-recovery failure, verify the dedicated current-page
   warning. Keep the page open to retry; do not bypass a security restriction.
6. Enable background JPEG preparation before reading. Export before every
   thumbnail is ready, then export again to check cache reuse. Verify CBZ order,
   actual files and JPEG sampling in a standard reader/inspection tool.
7. Test unavailable images, permission refusal and cancelled downloads. No
   incomplete or interrupted archive should be reported as successfully saved.

The user has reported working capture/conversion at intermediate stages, but
the latest UI/reset/warning changes still require real Firefox validation.
Automated fixtures and the example URLs do not establish general compatibility
with Scan-Manga or any other site. No blanket site-compatibility claim was made.
