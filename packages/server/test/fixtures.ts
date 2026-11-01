import sharp from "sharp";

/** Colours the fixtures are painted with (RGB). */
export const RED = { r: 255, g: 0, b: 0 };
export const BLUE = { r: 0, g: 0, b: 255 };

/**
 * A `width × height` raster: the left half red, the right half blue. The halves make a crop
 * or a rotation visible in the output (see `pixel`).
 */
export async function halvesImage(
  width: number,
  height: number,
  format: "png" | "jpeg" = "png",
  options: { orientation?: number } = {},
): Promise<Buffer> {
  const left = await sharp({
    create: { width: width / 2, height, channels: 3, background: RED },
  })
    .png()
    .toBuffer();
  let image = sharp({ create: { width, height, channels: 3, background: BLUE } }).composite([
    { input: left, left: 0, top: 0 },
  ]);
  if (options.orientation !== undefined) {
    image = image.withMetadata({ orientation: options.orientation });
  }
  return format === "jpeg" ? image.jpeg({ quality: 95 }).toBuffer() : image.png().toBuffer();
}

/** A 200 × 100 PNG, red | blue. */
export const pngFixture = () => halvesImage(200, 100, "png");

/**
 * A 200 × 100 JPEG, red | blue, with EXIF `Orientation = 6` (rotate 90° clockwise to display):
 * shown correctly it is 100 × 200 with red ON TOP of blue.
 */
export const jpegExifFixture = () => halvesImage(200, 100, "jpeg", { orientation: 6 });

/** Bytes that `file-type` calls a PNG (signature + IHDR) but no decoder can render. */
export function brokenPngFixture(): Buffer {
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d49484452000000c8000000640806000000", "hex"),
    Buffer.alloc(64, 0xab),
  ]);
}

/**
 * A one-page 200 × 100 pt PDF whose left half is a red rectangle, the right half white: what
 * `pdftoppm` renders is red | white, so a thumbnail of it has red on the left.
 */
export function pdfFixture(): Buffer {
  const content = "1 0 0 rg 0 0 100 100 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The decoded image: dimensions and a pixel reader (RGBA, 0–255). */
export async function decode(bytes: Buffer): Promise<{
  width: number;
  height: number;
  format: string;
  pixel: (x: number, y: number) => Pixel;
}> {
  const meta = await sharp(bytes).metadata();
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    format: meta.format ?? "unknown",
    pixel: (x, y) => {
      const i = (y * info.width + x) * 4;
      return { r: data[i] ?? 0, g: data[i + 1] ?? 0, b: data[i + 2] ?? 0, a: data[i + 3] ?? 0 };
    },
  };
}

/** `true` when the pixel is (close to) red. */
export const isRed = (p: Pixel) => p.r > 200 && p.g < 60 && p.b < 60 && p.a > 200;
/** `true` when the pixel is (close to) blue. */
export const isBlue = (p: Pixel) => p.b > 200 && p.r < 60 && p.g < 60 && p.a > 200;
/** `true` when the pixel is transparent padding. */
export const isTransparent = (p: Pixel) => p.a < 20;

/** Polls `check` until it returns a non-null value, or fails after `timeoutMs`. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${options.label ?? "condition"}`);
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 50));
  }
}
