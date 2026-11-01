#!/usr/bin/env node
/**
 * Generates the demo pack of the examples site into `apps/examples/assets/` (see ASSETS.md):
 * every file is drawn, written or synthesised here — nothing is downloaded, so the pack has
 * no licence but the repository's. Run from the repository root after `pnpm install`:
 *
 *   node apps/examples/scripts/make-assets.mjs
 *
 * Needs `sharp` (resolved from packages/server) and `ffmpeg` on PATH for the clip and the tone.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "assets");
const require = createRequire(join(here, "..", "..", "..", "packages", "server", "package.json"));
const sharp = require("sharp");

for (const dir of ["images", "documents", "media", "encrypted"]) {
  mkdirSync(join(out, dir), { recursive: true });
}

/** An SVG document `width × height` with `body` inside. */
const svg = (width, height, body) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  );

// --- images -----------------------------------------------------------------------------------

// aurora.jpg: a landscape of soft bands, EXIF-free, 1600 × 1000.
await sharp(
  svg(
    1600,
    1000,
    `<defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0b1026"/><stop offset="0.55" stop-color="#1f3a5f"/><stop offset="1" stop-color="#0d2a3a"/>
      </linearGradient>
      <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3ddc97" stop-opacity="0.0"/><stop offset="0.5" stop-color="#3ddc97" stop-opacity="0.55"/><stop offset="1" stop-color="#8a5cf6" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    <rect width="1600" height="1000" fill="url(#sky)"/>
    <path d="M0 420 C 300 300, 500 560, 800 440 S 1300 260, 1600 380 L1600 700 L0 700 Z" fill="url(#glow)"/>
    <path d="M0 520 C 350 440, 600 640, 900 520 S 1350 380, 1600 470 L1600 760 L0 760 Z" fill="url(#glow)" opacity="0.6"/>
    <path d="M0 1000 L0 780 L220 720 L420 790 L640 690 L860 760 L1080 680 L1300 740 L1600 660 L1600 1000 Z" fill="#070a14"/>
    ${Array.from({ length: 90 }, (_, i) => {
      const x = (i * 977) % 1600;
      const y = (i * 613) % 520;
      return `<circle cx="${x}" cy="${y}" r="${1 + (i % 3) * 0.6}" fill="#fff" opacity="${0.4 + (i % 5) * 0.12}"/>`;
    }).join("")}`,
  ),
)
  .jpeg({ quality: 86 })
  .toFile(join(out, "images", "aurora.jpg"));

// geometry.png: a square poster of shapes, 1200 × 1200 — crops are visible on it.
await sharp(
  svg(
    1200,
    1200,
    `<rect width="1200" height="1200" fill="#f4efe6"/>
    <circle cx="380" cy="420" r="260" fill="#e2503b"/>
    <rect x="560" y="560" width="480" height="480" fill="#1d4ed8" transform="rotate(12 800 800)"/>
    <polygon points="900,120 1120,520 680,520" fill="#f5b400"/>
    <rect x="80" y="860" width="520" height="90" fill="#111827"/>
    <circle cx="1000" cy="300" r="60" fill="#111827"/>`,
  ),
)
  .png({ compressionLevel: 9 })
  .toFile(join(out, "images", "geometry.png"));

// portrait.webp: tall, with a face-like figure off-centre (the `attention` crop finds it).
await sharp(
  svg(
    900,
    1400,
    `<rect width="900" height="1400" fill="#dbe7f0"/>
    <rect x="0" y="900" width="900" height="500" fill="#8fb3c9"/>
    <circle cx="300" cy="520" r="150" fill="#f1c7a3"/>
    <circle cx="245" cy="500" r="16" fill="#222"/><circle cx="355" cy="500" r="16" fill="#222"/>
    <path d="M250 580 Q300 630 350 580" stroke="#222" stroke-width="10" fill="none" stroke-linecap="round"/>
    <path d="M150 1000 Q300 700 450 1000 Z" fill="#c2410c"/>`,
  ),
)
  .webp({ quality: 88 })
  .toFile(join(out, "images", "portrait.webp"));

// grid.png: a labelled grid, 1024 × 640 — every crop mode and size shows which part survived.
{
  const cells = [];
  const cols = 8;
  const rows = 5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hue = ((r * cols + c) * 37) % 360;
      cells.push(
        `<rect x="${c * 128}" y="${r * 128}" width="128" height="128" fill="hsl(${hue} 70% 55%)"/>`,
        `<text x="${c * 128 + 64}" y="${r * 128 + 74}" font-family="monospace" font-size="34" text-anchor="middle" fill="#fff">${String.fromCharCode(65 + r)}${c + 1}</text>`,
      );
    }
  }
  await sharp(svg(1024, 640, cells.join("")))
    .png()
    .toFile(join(out, "images", "grid.png"));
}

// --- documents --------------------------------------------------------------------------------

/** A one-page A4 PDF with `lines` of Helvetica text (what tesseract reads on the OCR example). */
function textPdf(lines) {
  const content = [
    "BT",
    "/F1 22 Tf",
    "72 760 Td",
    "26 TL",
    ...lines.map((line, i) => `(${line.replace(/[()\\]/g, "\\$&")}) ${i === 0 ? "Tj" : "'"}`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

writeFileSync(
  join(out, "documents", "ocr-sample.pdf"),
  textPdf([
    "JSVola demo document",
    "",
    "This page exists so the OCR example has text to read.",
    "The worker renders the first page with pdftoppm and runs",
    "tesseract over it; the words land in vola_file_metadata and",
    "GET /files/.../info answers them under the ocr block.",
    "",
    "Invoice number: 2026-0042",
    "Amount due: 1,250.00 EUR",
    "Reference: VOLA-EXAMPLES-OCR",
  ]),
);

writeFileSync(
  join(out, "documents", "notes.txt"),
  [
    "JSVola examples: a plain text file.",
    "",
    "Text files have no thumbnail (the Thumbnails page shows the 404 placeholder for them),",
    "download with Content-Disposition: attachment, and count as kind = document.",
    "",
  ].join("\n"),
);

// --- media (ffmpeg) ---------------------------------------------------------------------------

// clip.mp4: 8 s of a moving test pattern with a burnt-in clock, 480 × 270, H.264 baseline.
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=480x270:rate=24:duration=8",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=330:sample_rate=44100:duration=8",
  "-c:v",
  "libx264",
  "-profile:v",
  "baseline",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "30",
  "-g",
  "24",
  "-c:a",
  "aac",
  "-b:a",
  "48k",
  "-movflags",
  "+faststart",
  "-shortest",
  join(out, "media", "clip.mp4"),
]);

// tone.mp3: 12 s of three tones in turn.
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=44100:duration=4",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=554:sample_rate=44100:duration=4",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=659:sample_rate=44100:duration=4",
  "-filter_complex",
  "[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=0.4[a]",
  "-map",
  "[a]",
  "-c:a",
  "libmp3lame",
  "-b:a",
  "64k",
  join(out, "media", "tone.mp3"),
]);

// --- encrypted (uploaded with encryption=tenant by the seeder) ----------------------------------

await sharp(
  svg(
    1000,
    700,
    `<rect width="1000" height="700" fill="#101828"/>
    <rect x="80" y="80" width="840" height="540" rx="24" fill="#1f2a44" stroke="#60a5fa" stroke-width="6"/>
    <text x="500" y="300" font-family="sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="#e0e7ff">ENCRYPTED</text>
    <text x="500" y="380" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#93c5fd">stored as JSV v1 under the tenant key</text>
    <text x="500" y="440" font-family="monospace" font-size="26" text-anchor="middle" fill="#a7f3d0">AES-256-GCM, 1 MiB segments</text>`,
  ),
)
  .png()
  .toFile(join(out, "encrypted", "vault-poster.png"));

writeFileSync(
  join(out, "encrypted", "confidential.pdf"),
  textPdf([
    "CONFIDENTIAL",
    "",
    "This PDF is stored encrypted at rest (encryption = tenant).",
    "The server decrypts it for an authorised download, renders",
    "its thumbnail inline under the same file key, and never writes",
    "the plaintext to disk.",
  ]),
);

console.log(`demo pack written to ${out}`);
