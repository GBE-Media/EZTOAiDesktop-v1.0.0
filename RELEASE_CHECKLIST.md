# Release Checklist

## One-time setup
- Enable Windows Developer Mode (or run packaging as Administrator).
- Replace OCR files:
  - build/tessdata/eng.traineddata
  - build/tessdata/spa.traineddata

## Before packaging
- Create `.env.production` with:
  - VITE_SUPABASE_URL=...
  - VITE_SUPABASE_PUBLISHABLE_KEY=...
  - VITE_EXTERNAL_SUPABASE_URL=...
  - VITE_EXTERNAL_SUPABASE_ANON_KEY=...

## Package
- npm install
- npm run package

## Verify output
- Check `release/` for:
  - Installer .exe
  - latest.yml

## Publish (GitHub Releases)
- GitHub Releases for public repos always include “Source code (zip/tar.gz)” links
- To prevent source access, make the repo **private** or host the installer elsewhere
- If using GitHub Releases:
  - Create a new GitHub Release
  - Upload all files from `release/`
  - Users will auto-update on next launch

## CI Auto-Release (GitHub Actions)
- Every push to `main` bumps a patch version (`[skip ci]` so the bump commit does not start another release run), then builds Windows and macOS installers from that bump commit SHA
- A dedicated `create-release` job creates GitHub Release `v<version>` as a **draft** once; matrix jobs only attach platform assets to that draft
- `verify-release` **fails the workflow** (and **leaves the release as a draft**) if the tag is missing any of: an x64 `.exe`, `latest.yml`, a `.dmg` or `.zip`, `latest-mac.yml`. Only when all are present does it run `gh release edit --draft=false --latest` so clients never see an incomplete Latest release
- Each platform publishes unless **that** platform's full updater set is already on the release (Windows: `latest.yml` **and** an x64 `.exe`; macOS: `latest-mac.yml` **and** a `.dmg` or `.zip`)
- CI deletes older **published** releases before publish and keeps the newest 10; it never deletes drafts or the tag matching the current `package.json` version
- In-flight release runs are not cancelled by a later push to `main` (they queue)
- You can disable CI by removing `.github/workflows/release.yml`
