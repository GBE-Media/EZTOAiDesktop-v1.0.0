/**
 * Icon Generator Script
 * 
 * This script generates ICO files from the source PNG icon.
 * Run locally when updating the app icon.
 * 
 * Usage:
 *   npm run icons:generate
 */

const sharp = require('sharp');
const toIco = require('to-ico');
const fs = require('fs');
const path = require('path');

const inputPath = path.join(__dirname, '..', 'build', 'icon-1024.png');
const outputPath = path.join(__dirname, '..', 'build', 'icon.ico');
const faviconPath = path.join(__dirname, '..', 'public', 'favicon.ico');

const sizes = [16, 32, 48, 64, 128, 256];

async function generateIco() {
  try {
    console.log('Reading source image:', inputPath);

    const metadata = await sharp(inputPath).metadata();
    if (
      metadata.format !== 'png' ||
      metadata.width !== 1024 ||
      metadata.height !== 1024 ||
      !metadata.hasAlpha
    ) {
      throw new Error(
        'build/icon-1024.png must be a genuine 1024x1024 PNG with an alpha channel.'
      );
    }

    const sourceBuffer = await sharp(inputPath)
      .toColorspace('srgb')
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer();

    // Generate RGBA PNG frames at every Windows icon size.
    const pngBuffers = await Promise.all(
      sizes.map(async size => {
        console.log(`Generating ${size}x${size}...`);
        return sharp(sourceBuffer)
          .resize(size, size, {
            kernel: sharp.kernel.lanczos3,
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .toColorspace('srgb')
          .ensureAlpha()
          .png({ compressionLevel: 9 })
          .toBuffer();
      })
    );

    console.log('Converting to ICO format...');
    
    // Convert to ICO
    const icoBuffer = await toIco(pngBuffers);
    
    // Write ICO files
    fs.writeFileSync(outputPath, icoBuffer);
    fs.writeFileSync(faviconPath, icoBuffer);
    
    console.log('ICO files created successfully!');
    console.log('  - build/icon.ico');
    console.log('  - public/favicon.ico');
  } catch (err) {
    console.error('Error creating ICO:', err);
    process.exit(1);
  }
}

generateIco();
