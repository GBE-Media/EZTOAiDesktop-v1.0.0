/**
 * Extract page-zoning fixtures from real bid-set PDFs.
 *
 *   npx vite-node scripts/extract-zone-fixtures.ts <pdf> <page> <outName> [<pdf> <page> <outName> ...]
 *
 * Writes src/test/fixtures/zones/<outName>.json.gz (viewport-space text items + vector segments).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractZoneInputs } from '../src/services/ai/detection/pageZones';

const args = process.argv.slice(2);
if (!args.length || args.length % 3 !== 0) {
  console.error('usage: extract-zone-fixtures.ts <pdf> <page> <outName> ...');
  process.exit(1);
}
for (let i = 0; i < args.length; i += 3) {
  const [file, pageStr, name] = args.slice(i, i + 3);
  const data = new Uint8Array(readFileSync(file));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false } as never).promise;
  const page = await doc.getPage(Number(pageStr));
  const input = await extractZoneInputs(page as never);
  const payload = {
    source: path.basename(file),
    page: Number(pageStr),
    rotate: page.rotate,
    pageWidth: input.pageWidth,
    pageHeight: input.pageHeight,
    textItems: input.textItems,
    segments: Array.from(input.segments || []),
  };
  const out = path.resolve('src/test/fixtures/zones', `${name}.json.gz`);
  writeFileSync(out, gzipSync(JSON.stringify(payload)));
  console.log(`${name}: ${input.textItems.length} text, ${(input.segments?.length || 0) / 4} segments -> ${out}`);
  await doc.destroy();
}
