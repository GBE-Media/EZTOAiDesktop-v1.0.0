/**
 * Range-load bench matching app loadPDFFromUrl (PDFDataRangeTransport + disableStream).
 * Default BENCH_PAGES=200. Review file used 1000 (~300 MB with rasters).
 */
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const PAGES = Number(process.env.BENCH_PAGES || 200);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makeNoisePng(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    crypto.randomFillSync(raw, y * stride + 1, width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function buildPdf(pages) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const large = i % 5 !== 1;
    const page = pdf.addPage(large ? [2592, 1728] : [612, 792]);
    page.drawText(`Sheet ${i + 1}  TITLE BLOCK E-${String(100 + (i % 50)).padStart(3, '0')}`, {
      x: 72,
      y: page.getHeight() - 72,
      size: 14,
      font,
    });
    page.drawText('GENERAL NOTES AND KEYNOTES FOR THIS SHEET', { x: 72, y: page.getHeight() - 100, size: 10, font });
    if (i % 10 === 0) {
      const png = await pdf.embedPng(makeNoisePng(960, 720));
      page.drawImage(png, { x: 200, y: 120, width: 1200, height: 900 });
    }
  }
  return pdf.save();
}

function serve(bytes) {
  let rangeCount = 0;
  let served = 0;
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (!range) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${bytes.length}`);
      res.end();
      return;
    }
    const m = /^bytes=(\d+)-(\d*)$/i.exec(range);
    if (!m) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${bytes.length}`);
      res.end();
      return;
    }
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : Math.min(start + (1 << 20) - 1, bytes.length - 1);
    const slice = bytes.subarray(start, Math.min(end + 1, bytes.length));
    rangeCount += 1;
    served += slice.length;
    res.statusCode = 206;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Range', `bytes ${start}-${start + slice.length - 1}/${bytes.length}`);
    res.setHeader('Content-Length', String(slice.length));
    res.end(Buffer.from(slice));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/doc.pdf`, stats: () => ({ rangeCount, served }) });
    });
  });
}

async function main() {
  const rss0 = process.memoryUsage().rss;
  const bytes = await buildPdf(PAGES);
  const { server, url, stats } = await serve(bytes);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  class FileRangeTransport extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin, end) {
      fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } })
        .then(r => r.arrayBuffer())
        .then(b => this.onDataRange(begin, new Uint8Array(b)));
    }
  }

  const tOpen = performance.now();
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const size = Number(head.headers.get('Content-Range').split('/')[1]);
  const task = pdfjs.getDocument({
    range: new FileRangeTransport(size, new Uint8Array(0)),
    rangeChunkSize: 1 << 20,
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const openMs = performance.now() - tOpen;

  const tFirst = performance.now();
  const page1 = await doc.getPage(1);
  await page1.getTextContent();
  await page1.getOperatorList();
  const firstMs = performance.now() - tFirst;

  const flips = [];
  for (let i = 0; i < 50; i++) {
    const n = 1 + Math.floor(Math.random() * doc.numPages);
    const t = performance.now();
    const p = await doc.getPage(n);
    await p.getTextContent();
    flips.push(performance.now() - t);
  }
  const { rangeCount, served } = stats();
  const rss = process.memoryUsage().rss;
  console.log(JSON.stringify({
    pages: doc.numPages,
    bytes: bytes.length,
    openMs: Math.round(openMs),
    firstPageMs: Math.round(firstMs),
    flipP50: Math.round(percentile(flips, 50)),
    flipP95: Math.round(percentile(flips, 95)),
    rangeCount,
    servedBytes: served,
    rssMb: Math.round(rss / 1e6),
    rssDeltaMb: Math.round((rss - rss0) / 1e6),
  }, null, 2));
  server.close();
  await doc.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
