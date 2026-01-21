// Simple script to remind user to create icon
// The logo image needs to be converted to .ico format
// 
// Instructions:
// 1. Use an online converter like https://convertio.co/png-ico/
// 2. Upload the logo.png file
// 3. Set size to 256x256
// 4. Download and save as public/favicon.ico
// 
// Or use ImageMagick:
// magick convert public/logo.png -define icon:auto-resize=256,128,64,48,32,16 public/favicon.ico

console.log('Icon conversion needed!');
console.log('Please convert public/logo.png to public/favicon.ico');
console.log('Recommended size: 256x256');
console.log('Use: https://convertio.co/png-ico/ or ImageMagick');
