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
    // Generate PNGs at different sizes
    const pngBuffers = await Promise.all(
      sizes.map(size =>
        sharp(inputPath)
          .resize(size, size)
          .png()
          .toBuffer()
      )
    );

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
