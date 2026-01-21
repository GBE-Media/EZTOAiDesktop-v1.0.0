# Icon Setup Instructions

## Current Status
- ✅ Logo file exists at `public/logo.png` (your excavator logo)
- ⚠️ Need to convert to `.ico` format for Windows icon support

## How to Create the Icon

### Option 1: Online Converter (Easiest)
1. Go to https://convertio.co/png-ico/
2. Upload `public/logo.png`
3. Set output size to **256x256** (or multi-size: 16, 32, 48, 64, 128, 256)
4. Download the converted file
5. Save it as `public/favicon.ico` (replace existing file)

### Option 2: Using ImageMagick (Command Line)
If you have ImageMagick installed:
```bash
cd "D:\TheBEMedia\EasyTakeOff\EZTO Ai\ezto-ai-desktopv1-main"
magick convert public/logo.png -define icon:auto-resize=256,128,64,48,32,16 public/favicon.ico
```

### Option 3: Using GIMP (Free Software)
1. Download GIMP from https://www.gimp.org/
2. Open `public/logo.png` in GIMP
3. Scale image to 256x256 (Image → Scale Image)
4. Export as `.ico` (File → Export As → save as `favicon.ico`)
5. Replace `public/favicon.ico` with your exported file

## After Converting
Once you've created the `.ico` file:
1. Rebuild the app: `npm run build`
2. Rebuild Electron: `npm run electron:build`
3. Launch: `npm run electron:dev`

The icon will now appear:
- In the window title bar
- In the taskbar
- For `.ezto` files in Windows Explorer (after building installer)

## Building the Installer
To create a distributable installer with the icon:
```bash
npm run build
npm run electron:build
npx electron-builder
```

This will create installers in the `release/` folder with your custom icon!
