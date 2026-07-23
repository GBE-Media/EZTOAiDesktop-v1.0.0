# Icon Setup Instructions

## Canonical Icon Flow
- Source artwork: `build/icon-1024.png`
- Optional UI logo copy: `public/logo.png`
- Generated icon outputs:
  - `build/icon.ico` (Windows app + installer icon)
  - `public/favicon.ico` (renderer favicon + Linux icon input)

Do not edit `build/icon.ico` or `public/favicon.ico` by hand. Generate them from `build/icon-1024.png`.

## Generate Icons Locally
From the project root:

```bash
npm run icons:generate
```

This script regenerates:
- `build/icon.ico`
- `public/favicon.ico`

## Package With Fresh Icons
The packaging script now runs icon generation automatically:

```bash
npm run package
```

This ensures installer/runtime icon assets are refreshed before `electron-builder` runs.

## CI Behavior
GitHub Actions also runs `npm run icons:generate` before build/publish, so Windows release artifacts stay in sync with `build/icon-1024.png`.

## Where Icons Appear
- App executable icon (Windows)
- Installer / uninstaller icon (NSIS)
- Taskbar / window icon
- `.bidveraai` file association icon
