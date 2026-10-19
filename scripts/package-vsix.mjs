// Zero-dependency VSIX packager for environments where `npx @vscode/vsce` is
// not available. Prefer `npm run package` (official vsce) when you can.
//
// A .vsix is a ZIP with [Content_Types].xml, extension.vsixmanifest and the
// extension files under extension/. This script reproduces what vsce emits for
// an extension with no runtime dependencies.
//
//   node scripts/build.mjs --production && node scripts/package-vsix.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const include = [
  ['package.json', 'extension/package.json'],
  ['README.md', 'extension/README.md'],
  ['CHANGELOG.md', 'extension/CHANGELOG.md'],
  ['LICENSE', 'extension/LICENSE.txt'],
  ['dist/extension.js', 'extension/dist/extension.js'],
  ['dist/webview.js', 'extension/dist/webview.js'],
  ['dist/codicons/codicon.css', 'extension/dist/codicons/codicon.css'],
  ['dist/codicons/codicon.ttf', 'extension/dist/codicons/codicon.ttf'],
  ['media/dashboard.css', 'extension/media/dashboard.css'],
  ['media/icon.svg', 'extension/media/icon.svg'],
  ['media/icon.png', 'extension/media/icon.png'],
];
for (const [src] of include) {
  if (!fs.existsSync(path.join(root, src))) {
    console.error(`Missing ${src}. Run "node scripts/build.mjs --production" first.`);
    process.exit(1);
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords ?? []).join(','))}</Tags>
    <Categories>${esc((pkg.categories ?? []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const types = { '.json': 'application/json', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown', '.txt': 'text/plain', '.vsixmanifest': 'text/xml' };
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${Object.entries(types)
  .map(([ext, t]) => `<Default Extension="${ext}" ContentType="${t}"/>`)
  .join('')}</Types>
`;

// ---- minimal ZIP writer (deflate, CRC-32) ----
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const entries = [
  ['[Content_Types].xml', Buffer.from(contentTypes)],
  ['extension.vsixmanifest', Buffer.from(manifest)],
  ...include.map(([src, dest]) => [dest, fs.readFileSync(path.join(root, src))]),
];

const chunks = [];
const central = [];
let offset = 0;
const { time, date } = dosDateTime();
for (const [name, data] of entries) {
  const nameBuf = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, compressed);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(compressed.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);
  offset += local.length + nameBuf.length + compressed.length;
}
const cdBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cdBuf.length, 12);
end.writeUInt32LE(offset, 16);

const out = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
fs.writeFileSync(out, Buffer.concat([...chunks, cdBuf, end]));
console.log(`Packaged ${path.basename(out)} (${entries.length} files, ${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
