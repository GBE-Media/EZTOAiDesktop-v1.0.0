/**
 * Icon Generator Script
 * 
 * This script generates ICO files from the source PNG icon.
 * Run locally when updating the app icon.
 * 
 * Usage:
 *   npm install sharp to-ico --no-save
 *   node scripts/generate-ico.cjs
 * 
 * These packages are NOT in package.json to avoid CI build failures
 * (sharp has native dependencies that fail on some CI runners).
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
    
    // First, ensure proper color handling by converting to sRGB
    const sourceImage = sharp(inputPath)
      .flatten({ background: { r: 10, g: 10, b: 10 } }) // Match the black background
      .toColorspace('srgb');
    
    // Generate PNGs at different sizes with high quality
    const pngBuffers = await Promise.all(
      sizes.map(async size => {
        console.log(`Generating ${size}x${size}...`);
        return sharp(await sourceImage.toBuffer())
          .resize(size, size, {
            kernel: sharp.kernel.lanczos3,
            fit: 'contain',
            background: { r: 10, g: 10, b: 10, alpha: 1 }
          })
          .png({ quality: 100, compressionLevel: 9 })
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
