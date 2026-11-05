// Adds home-screen (PWA) tags to the exported web build and prepares it for GitHub Pages.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const base = '/miles-and-pence';
const file = path.join(dist, 'index.html');
let html = fs.readFileSync(file, 'utf8');

const tags = `
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Miles & Pence">
<link rel="apple-touch-icon" href="${base}/apple-touch-icon.png">
<link rel="manifest" href="${base}/manifest.json">
<style>html,body{background:#0E1A17}</style>`;
html = html
  .replace('content="width=device-width, initial-scale=1, shrink-to-fit=no"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"')
  .replace('</head>', tags + '\n</head>');
fs.writeFileSync(file, html);

fs.copyFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), path.join(dist, 'apple-touch-icon.png'));
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify({
  name: 'Miles & Pence', short_name: 'Miles & Pence', start_url: base + '/', scope: base + '/',
  display: 'standalone', background_color: '#0E1A17', theme_color: '#0E1A17',
  icons: [{ src: base + '/apple-touch-icon.png', sizes: '1024x1024', type: 'image/png' }],
}, null, 2));
// GitHub Pages runs Jekyll by default, which hides the _expo folder.
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
console.log('postbuild: PWA tags, manifest and .nojekyll added');
