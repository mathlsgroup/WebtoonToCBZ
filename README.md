# Webtoon to CBZ — v0.1 prototype

Firefox-first extension for capturing chapter images **while you browse** and exporting a CBZ archive without changing image formats.

## Requirements
- Node.js 20+ and npm
- Firefox
- VS Code (optional)

## Build and run
```powershell
npm install
npm run build
npm run dev
```
`npm run dev` launches a temporary Firefox profile with the extension. Alternatively, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `dist/manifest.json`.

## Workflow
1. Open a chapter in Firefox and complete any human verification yourself.
2. Click the extension icon and press **Start**.
3. Browse the full chapter so images load. The extension records images in the order first detected.
4. Click **Stop**. Uncheck ads or other unwanted images.
5. Enter a filename and click **Export selected images to CBZ**.

## Known limitations
- Prototype: no automatic scrolling or page navigation yet.
- Reloading or navigating to a new document resets capture; single-page readers work best.
- Image order is first-detection order and may require future site-specific corrections.
- Images smaller than 250×250 are ignored.
- Some sites block image refetching from extension pages (CORS, cookies, expiring URLs). Such images cannot be exported with this prototype.
- Popup closing does not stop capture, but opening the popup is needed for export.
- No DRM, CAPTCHA or access-control bypass. Use only for content you have permission to save.

## Source files
- `src/content.ts`: image observation and capture.
- `src/popup.ts`: review and CBZ creation.
- `src/background.ts`: placeholder for future persistence.

## Next milestones
- Persist capture across chapter page transitions.
- More robust capture of image responses and lazy-loaded content.
- Reorder controls, site adapters, chapter metadata.
