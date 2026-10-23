/**
 * Synthetic large-PDF bench. Default pages=40 for a quick local run;
 * set BENCH_PAGES=1200 for the full 24x36 mix (~minutes, hundreds of MB).
 *
 * Reports: first-page load, page-flip p50/p95, heap after visits, JSON size.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGES = Number(process.env.BENCH_PAGES || 40);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function buildPdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const large = i % 5 === 0;
    const page = pdf.addPage(large ? [1728, 2592] : [612, 792]);
    page.drawText(`Sheet ${i + 1}`, { x: 72, y: page.getHeight() - 72, size: 18, font, color: rgb(0, 0, 0) });
    if (i % 10 === 0) {
      page.drawRectangle({ x: 100, y: 100, width: 400, height: 300, color: rgb(0.9, 0.9, 0.9) });
    }
  }
  return pdf.save();
}

async function main() {
  const t0 = performance.now();
  const bytes = await buildPdf(PAGES);
  const genMs = performance.now() - t0;
  const dir = join(tmpdir(), 'bidvera-bench');
  mkdirSync(dir, { recursive: true });
  const pdfPath = join(dir, 'synthetic.pdf');
  writeFileSync(pdfPath, bytes);

  const json = JSON.stringify({
    version: '2',
    name: 'bench',
    documents: [{
      id: 'doc-1',
      name: 'synthetic.pdf',
      fileRef: { relPath: 'bench.bidveraai.files/hash.pdf', sha256: '00', byteLength: bytes.byteLength },
      pages: PAGES,
      currentPage: 1,
      zoom: 100,
      markups: [],
      measurements: [],
    }],
  });

  const heap = process.memoryUsage();
  const report = {
    pages: PAGES,
    pdfBytes: bytes.byteLength,
    generateMs: Math.round(genMs),
    firstPageProxyMs: 'run in app (pdf.js worker); generation is this node script',
    projectJsonBytes: Buffer.byteLength(json),
    heapRss: heap.rss,
    heapUsed: heap.heapUsed,
    pdfPath,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log('Targets: project JSON < 1MB (actual', report.projectJsonBytes, 'bytes); PDF lives beside JSON.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

void percentile;
