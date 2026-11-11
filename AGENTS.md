# WebtoonToCBZ — Agent instructions

## Project purpose
Build a Firefox-first browser extension that helps the user archive **images they are authorized to save** from webtoon/manga chapters they visit into offline `.cbz` files. The user currently reads every page, manually retrieves images from the browser cache, renames them, and packages CBZ archives. The goal is to remove this repetitive work while retaining a simple, reviewable workflow.

## User preferences
- Discuss requirements, test results, and instructions with the user **in French**.
- Write **code, identifiers, comments, and technical documentation in English**.
- Prefer simple, maintainable implementations and small, testable increments.
- Primary browser: **Firefox** on Windows; Chrome/Edge compatibility is optional later.
- Preferred editor: VS Code; version control: Git.
- Preserve original image formats and bytes whenever feasible (usually JPEG; also PNG, WebP, and potentially AVIF). Do not convert everything to JPEG.
- Output format: `.cbz` (standard ZIP archive with correctly ordered image entries).

## Product workflow
1. User opens a chapter in their normal Firefox session and completes any human verification themselves.
2. User starts capture, then reads/scrolls/navigates normally.
3. Extension records eligible chapter images and their reading order, including across page changes when supported.
4. User reviews thumbnails, removes false positives, and optionally reorders pages.
5. Extension exports a CBZ named like `Tales of Demons and Gods - 0280.cbz`.

Support both long vertical chapters and paginated readers. Do not assume that all images are present in the DOM at once; sites may lazy-load or replace image elements. A future optional automatic traversal mode may scroll or navigate accessible chapter pages, but must pause for human challenges and respect site restrictions.

## Initial test sites (examples, not guaranteed compatible)
- `https://manhuaplus.com/manga/tales-of-demons-and-gods01/chapter-280/`
- `https://www.topmanhua.fan/manhua/god-of-martial-arts-original-translation/chapter-1`
- `https://www.scan-manga.com/lecture-en-ligne/Genius-Blacksmith-s-Game-Chapitre-1-FR_490394.html`

Treat each site as an integration test requiring real browser validation. Avoid claims of compatibility until tested. Prefer generic detection with narrowly scoped per-site adapters when necessary.

## Planned milestones
- **v0.1:** Firefox extension; start/stop capture; identify images seen during reading; export an ordered CBZ.
- **v0.2:** Preview, manual exclusion/reordering, better deduplication and filtering.
- **v0.3:** Optional assisted chapter traversal (scrolling or page-by-page) on supported sites.
- **v0.4:** Multiple chapters, naming conventions, duplicate-chapter detection, optional library organization.

Milestones are targets, not assertions that features already work. Inspect the repository before making changes.

## Suggested architecture (adapt to actual repository)
- TypeScript and WebExtensions APIs.
- Manifest compatible with Firefox; request minimal permissions.
- Content script: observe document images and lazy loading using DOM observers; record reading order.
- Background script: coordinate capture state and browser navigation where needed.
- Popup: start/stop, status, export actions.
- Preview page: thumbnails and ordering (later milestone).
- Export module: generate ZIP/CBZ with zero-padded sequential filenames, retaining original extensions.
- Prefer IndexedDB or another suitable extension storage mechanism for larger image payloads; do not put large binaries in `storage.sync`.

## Engineering requirements
- Before editing, inspect `package.json`, manifest, source tree, and README. Do not assume a proposed structure exists.
- Keep each change focused. Explain modified files and provide exact build/test commands.
- Run available checks (`npm install`, `npm run build`, tests) when the environment permits; report any checks not run.
- Handle lazy loading, duplicate URLs, repeated images, missing images, network errors, and uncertain ordering explicitly.
- Avoid arbitrary size-only filters that might discard legitimate narrow/tall webtoon strips; offer review instead.
- Maintain image order independently from asynchronous download completion.
- Sanitize filenames; use stable, zero-padded image names (`0001.jpg`, `0002.png`, etc.).
- Preserve original image data and file types where possible. Validate actual media type rather than trusting URL extensions alone.
- Keep exports readable by standard CBZ readers; avoid embedding advertisements or browser UI assets.
- Do not silently claim a successful export when images are missing or inaccessible.
- Do not add unnecessary analytics, telemetry, external services, or accounts.

## Access, copyright, and security boundaries
- Only support archiving where the user has permission or the site permits saving; personal/family use alone does not establish authorization.
- Do **not** bypass DRM, CAPTCHA, anti-bot challenges, paywalls, access controls, or other technical protections.
- Human verification must be performed manually by the user; pause rather than evade it.
- Do not harvest credentials, cookies, authentication tokens, or private browsing data.
- Do not add stealth automation, fingerprint spoofing, or proxy rotation.
- Avoid broad host permissions unless justified; document permissions and data flow.
- Keep captured data local by default.

## Collaboration with Codex
When asked to implement a feature:
1. Inspect the current code and state what already exists.
2. Propose the smallest safe change and identify assumptions.
3. Implement it, updating README or tests as appropriate.
4. Run the build/tests if possible.
5. Reply in French with a concise summary, verification results, and next manual Firefox test steps.

If the user reports a failure, prioritize reproducing and diagnosing it before redesigning the architecture.
