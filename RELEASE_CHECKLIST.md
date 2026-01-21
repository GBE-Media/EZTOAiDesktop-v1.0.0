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
- Create a new GitHub Release
- Upload all files from `release/`
- Users will auto-update on next launch
