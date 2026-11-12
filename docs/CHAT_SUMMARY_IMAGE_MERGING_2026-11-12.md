# Conversation summary: image merging and capture diagnosis

Recorded on 2026-11-12. This is a summary of the conversation available in this
thread, not a verbatim transcript or a statement that older implementation details
still describe the current repository. Inspect the code before further changes.
See also [the broader project handoff](CHAT_SUMMARY_2026-11-12.md), which covers
additional capture, navigation, persistence and JPEG-conversion work.

## Working conventions

- Discuss requirements, results and manual instructions in French.
- Write code, identifiers, comments and technical documentation in English.
- Target Firefox on Windows, preserve available original image bytes/formats,
  maintain reading order and export ordinary CBZ archives with sequential names.
- Keep data local. Do not bypass challenges, DRM or access controls. The user
  completes human verification and archives only images they are authorized to save.
- Prefer focused changes, inspect the repository first and distinguish automated
  test coverage from actual browser/site validation.

## Initial request: manual vertical merging

The user supplied a detailed implementation request in an attachment. Some sites
split complete pages into consecutive horizontal strips. The requested workflow
was to select strips, merge vertically, inspect the result, undo and export the
current list. Complete pages must not be merged automatically merely because they
are consecutive.

The implementation reported in this thread added:

- A merge selection separate from the existing export-inclusion checkboxes.
- Selection highlighting, validation and a **Merge vertically** action.
- Canvas composition in reading order, without scaling or cropping; narrower
  strips centered on a white background.
- JPEG quality 0.95 when every source is JPEG, otherwise PNG.
- Original source retention, independent/nested undo and full-size previews.
- Export of merged pages as single entries while preserving unmodified bytes.
- Explicit decoding, allocation, size, encoding and network errors; object-URL
  cleanup. The reported merge limits were 32767 pixels per side and 64 megapixels.

Relevant modules at that stage included `src/imageMerger.ts`, `src/popup.ts` and
`src/export.ts`. The user subsequently confirmed that the feature worked in Firefox.

## Git conflict incident

The user suspected a Git mistake and requested inspection, then correction.
The working tree was clean on `feature/wip`, but commit `110df3b` ("step 2")
contained committed `Updated upstream` / `Stashed changes` conflict markers in
`src/popup.ts`, `popup.html`, `popup.css` and `README.md`. It also restored older
capture/build/configuration code and removed test scripts.

The repair restored the coherent files from `904a568` ("step 1"), retained the
new `src/imageMerger.ts`, and removed an unused one-comment background stub.
History was preserved; no reset or history rewrite was performed. The changes
were left uncommitted at that point. Build, type checks, extension validation and
14 tests passed. These hashes describe that incident, not the present branch state.

## Page-number column and batch grouping

The user found repeatedly scrolling back to the merge button inconvenient. They
requested editable page numbers, with matching numbers identifying strips belonging
to the same page, and automatic suggestions based on landscape strips and white
top/bottom borders.

The resulting workflow introduced:

- An editable **Page number** column and a sticky action toolbar.
- **Suggest page numbers**, which proposes assignments without merging.
- **Merge numbered pages**, which processes all valid groups together.
- Validation that included images belonging to other pages cannot interrupt a group.
- Transactional batch composition: a failed group leaves the list intact and
  releases provisional merged outputs.
- A requirement to apply pending numbered groups or assign separate numbers before
  export. Number labels identify groups; list order determines export order.

The border heuristic inspected the first/last three native pixel rows. A row with
at least 98% near-white pixels (RGB channels at least 245 over white) counted as a
border. Candidate widths had to agree within 5%, and the combined image had to be
portrait. Ambiguous images remained separate with a note. Blank artwork and internal
gutters could still cause incorrect suggestions.

## Interleaved previews, reversible exclusions and ratio checking

Low-resolution next-chapter previews sometimes appeared between strips. The user
asked to hide them and allow merging across disabled rows.

Both numbered and checkbox merging were changed to ignore excluded images between
sources. Excluded rows remained available, and undo retained their original slots.
**Hide excluded images** provided reversible hiding. Included intervening images
still blocked merging.

The original border-based detector gained a ratio check: final height/width had to
be within 20% of the median ratio of at least two included portrait reference pages,
with at least two thirds of references agreeing within 20%. Excluded previews did
not contribute. Missing/inconsistent references left candidates for manual handling.
This earlier detector is distinct from the later automatic-analysis mode.

## Height-based fallback and tolerance

When border detection failed, the user requested an additional mode based on a
chosen final height. Their example comprised five strips of 302 px and one of
303 px, all 1280 px wide: the correct total was 1813 px.

**Target page height (px)** and **Suggest by height** were added. The user explicitly
rejected a hardcoded/default height, so the input starts blank. The number 1813 was
retained only as an example and regression fixture.

The user then clarified that heights should be close rather than exactly equal.
**Tolerance (%)** was introduced, defaulting to 1%, adjustable from 0 to 10%; zero
requires an exact match. The closest acceptable total is preferred, with fewer
strips on ties. This mode:

- Uses captured dimensions and does not require white borders or portrait references.
- Skips excluded rows, preserves existing merges and pages already near the target.
- Leaves unmatched groups separate and resumes searching at the next image.
- Replaces number assignments but does not perform the merge itself.
- Never resizes, crops or pads images to reach the target.

## User-controlled minimum width

The user requested a field to exclude small previews, specifically 320-by-320 images.
**Minimum image width (px)** starts blank; **Exclude narrower images** disables
included images strictly below the chosen threshold. For example, 321 excludes
320 px images while retaining images exactly 321 px wide.

Unknown dimensions are not excluded by this action. Exclusions are reversible and
survive toolbar refresh. Lowering the threshold does not re-enable earlier exclusions.
Grouping/export ignore disabled images. No fixed resolution threshold was imposed.

## Automatic analysis across different page heights

The user reported having to repeat detect/merge with three different heights and
requested a ratio-based automatic mode with accessible exclusions and exceptions
such as double pages.

**Analyze automatically** was added to propose the entire chapter in one pass,
followed by a single **Merge numbered pages** action. The reported implementation:

- Estimates the usual height/width ratio from similar included portrait pages,
  including previous merges; an optional reference ratio can override estimation.
- Does not assume a fixed chapter height or predefined page ratio.
- Uses a separate ratio tolerance, default 10%, adjustable from 0 to 20%.
- Finds consecutive strip groups at different resolutions/heights by combined ratio.
- Applies the minimum-width field if supplied and can skip narrower incompatible
  previews between real strips.
- Keeps matching complete pages, existing merges and restored exceptions separate.
- Leaves unknown dimensions included for manual review and sets aside unmatched
  images with an explanation, rather than deleting them.
- Preserves manual exclusions and refuses to change assignments when no reliable
  reference can be estimated and no explicit ratio is supplied.

**Review excluded (N)** filters the list to excluded images with reasons and previews.
**Restore as page** gives an exception its own number and protects it from subsequent
automatic reclassification. **Back to pages** returns to the main view. Ordinary
inclusion checkboxes can restore strips without that protection.

The module added for this work was `src/autoGrouping.ts`. This remains a geometric
heuristic: it can choose wrong boundaries, exclude legitimate unusual pages or retain
previews having the correct ratio. Reviewing exclusions and proposed groups is part
of the workflow. The user did not confirm this mode on the later failing site.

## Scan-Manga diagnosis and blob support

The user reported no images detected on:

https://www.scan-manga.com/lecture-en-ligne/Yaoshenji-Tales-of-Demons-and-Gods-TODAG-Chapitre-3245-FR_216463.html

The web-reading tool could not open the page. A Firefox inspection attempt through
Computer Use was stopped because URL-policy enforcement was not supported for that
Windows browser. No live browser compatibility claim followed that attempt.

The user first supplied initial page source, which contained an empty reader:

```html
<div class="img_lel" id="container"></div>
```

That alone did not explain the failure because capture already observed dynamic
image insertion. The user then supplied the rendered reader DOM, establishing:

- `#container.img_lel` advertised `data-nbpage="12"`.
- Image containers had `data-page`, `data-width`, `data-height` and loading metadata.
- Only the first two pages had loaded `<img>` elements; their sources were
  `blob:https://www.scan-manga.com/...`.
- Other page slots were empty lazy-loading placeholders.

The direct cause was the content script's HTTP(S)-only URL filter. The resulting
patch added same-origin blob capture while images were encountered during reading,
cached original bytes in the source context, and transferred bounded 256 KiB chunks
to review. `src/capturedBlobs.ts` validated transfers and image signatures; review
created local object URLs for previews. Export reused captured bytes instead of
trying to fetch a page-owned blob from the extension origin. No additional host
permissions were introduced.

A scoped Scan-Manga adapter used declared page numbers for order, ignored reader-external
UI images, avoided duplicates when a page received a replacement blob URL, and
reported unread/unloaded slots. Two captured pages out of twelve reported ten missing
and blocked incomplete export. Reading/scrolling remained manual. Blob failures,
stale generations, unsupported signatures and incomplete transfers were explicit.

That version supported JPEG, PNG, GIF, WebP and AVIF signatures; it could not recover
blobs already revoked before capture. Later capture/persistence/PNG-recovery work
is described in the broader handoff and may supersede these limitations. Do not
replace newer code with this historical implementation without inspecting it.

## Verification record for this thread

Automated checks reported passing progressively as features were added: 14 tests
after merge/Git repair; 25 after numbering; 30 after interleaved exclusions and ratio
checking; 34 after the height fallback; 36 after tolerance; 38 after minimum width;
46 after automatic ratio analysis; and 54 after blob capture and reader-slot handling.
The final implementation run in this thread also reported a successful TypeScript
check/build and extension lint without errors, notices or warnings.

These are historical run results, not tests rerun while writing this summary.
The broader handoff records later results. User-confirmed manual successes covered
the original merging feature, exclusion behavior and the minimum-width workflow;
automated fixtures alone did not establish live Scan-Manga compatibility.

The main commands used were:

```powershell
npm ci
npm run lint
npm test
npm run check:extension
```

At that stage, `npm test` included `npm run build`. Inspect the current package
scripts before running or changing the project's verification commands.

## Follow-up guidance

1. Preserve current repository changes and consult the broader handoff before
   resuming development; this thread describes an earlier stage of capture support.
2. Test ratio grouping on a real chapter containing different resolutions/heights,
   small interleaved previews and an exceptional double page. Verify that exclusions
   can be inspected, restored and kept separate on a later analysis.
3. Verify batch merge, individual/nested undo, preserved reading order and standard
   CBZ readability, including unchanged source bytes when no conversion is requested.
4. On Scan-Manga, start capture before reading and inspect loaded/saved/error counts
   through the whole chapter. Use the current implementation's navigation/persistence
   rules, not assumptions from this historical single-document version.
5. Never report an incomplete/failed export as successful or infer blanket site
   compatibility from the example URL or unit tests.
