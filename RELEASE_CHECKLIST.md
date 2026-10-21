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
- Every push to `main` bumps a patch version (`[skip ci]` so the bump commit does not start another release run), then builds Windows and macOS installers
- A dedicated `create-release` job creates GitHub Release `v<version>` once; matrix jobs only attach platform assets
- Each platform publishes unless **that** platform's updater manifest is already on the release (`latest.yml` on Windows, `latest-mac.yml` on macOS)
- The `verify-release` job **fails the workflow** if the new tag is missing any of: an x64 `.exe`, `latest.yml`, a `.dmg` or `.zip`, `latest-mac.yml`. Missing Windows `latest.yml` must not report success (that is what broke auto-update at v1.3.43).
- CI deletes older releases before publish and keeps the newest 10 (never deletes the tag matching the current `package.json` version)
- You can disable CI by removing `.github/workflows/release.yml`
