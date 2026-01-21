# PDF Editor - Desktop Application

A modern PDF editor desktop application built with Electron, React, TypeScript, and Vite.

## Features

- PDF viewing and editing capabilities
- Modern React-based user interface
- Built with Electron for cross-platform desktop support
- TypeScript for type safety
- Vite for fast development and building

## Prerequisites

- Node.js (v18 or higher recommended)
- npm

## Installation

1. Clone the repository (if you haven't already):
   ```bash
   git clone <repository-url>
   cd ezto-ai-desktopv1-main
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Development

### Run as Desktop Application (Recommended)

To run the application as a native desktop window:

```bash
npm run dev:electron
```

This will:
- Start the Vite development server
- Compile Electron TypeScript files
- Launch the Electron desktop window
- Enable hot module replacement (HMR) for development

### Run as Web Application

To run only the web development server (without Electron):

```bash
npm run dev
```

The application will be available at `http://localhost:8080`

## Building

### Build for Production

Build the application for production:

```bash
npm run build
```

### Build Electron Application

To create distributable desktop application packages:

```bash
npm run build
npm run electron:build
```

Then use electron-builder to create installers:
```bash
npx electron-builder
```

## Project Structure

- `src/` - React application source code
- `electron/` - Electron main process and preload scripts
- `public/` - Static assets
- `dist/` - Build output for web assets
- `dist-electron/` - Compiled Electron main process files

## Technologies

- **React** - UI library
- **TypeScript** - Programming language
- **Vite** - Build tool and dev server
- **Electron** - Desktop application framework
- **Tailwind CSS** - Styling
- **shadcn-ui** - UI component library

## Environment Variables

Create a `.env` file for development and a `.env.production` file for packaging:

```
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_key
VITE_EXTERNAL_SUPABASE_URL=your_auth_project_url
VITE_EXTERNAL_SUPABASE_ANON_KEY=your_auth_anon_key
# Optional: set a tessdata URL/path for offline OCR assets in development
VITE_TESSDATA_URL=
```

## Offline OCR (Tesseract)

Place the Tesseract language files in:

```
build/tessdata/eng.traineddata
build/tessdata/spa.traineddata
```

These files are bundled into the installer so OCR works without internet.

## Scripts

- `npm run dev` - Start Vite dev server (web only)
- `npm run dev:electron` - Start Electron desktop app in development
- `npm run build` - Build web assets for production
- `npm run electron:build` - Compile Electron TypeScript files
- `npm run electron:watch` - Watch and compile Electron files
- `npm run lint` - Run ESLint
- `npm run package` - Build and package the app with electron-builder

## Auto Updates (GitHub Releases)

1. Build and package: `npm run package`
2. Create a GitHub Release and upload the contents of `release/`
3. New installs will check GitHub for updates on app start

If you automate releases in CI, use a GitHub token with repo access.

## License

Private - All rights reserved
