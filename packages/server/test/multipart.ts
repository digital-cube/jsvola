import { Readable } from "node:stream";

/** One part of a multipart body: a text field, or a file (`filename` set). */
export interface MultipartPart {
  name: string;
  /** Text field value. */
  value?: string;
  filename?: string;
  contentType?: string;
  /** File content; a Readable streams it (see `multipartStream`). */
  data?: Buffer | Readable;
}

export const BOUNDARY = "----vola-test-boundary-7MA4YWxkTrZu0gW";

function partHeader(part: MultipartPart): string {
  if (part.filename === undefined) {
    return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`;
  }
  return (
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
    `Content-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`
  );
}

export const multipartHeaders = (extra: Record<string, string> = {}) => ({
  "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
  ...extra,
});

/** A complete multipart body as one Buffer (parts in the given order). */
export function multipartBody(parts: MultipartPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(partHeader(part), "utf8"));
    if (part.filename === undefined) chunks.push(Buffer.from(part.value ?? "", "utf8"));
    else if (Buffer.isBuffer(part.data)) chunks.push(part.data);
    else throw new Error("multipartBody needs Buffer data; use multipartStream for a Readable");
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

/** A multipart body as a Readable, streaming file parts from their Readable. */
export function multipartStream(parts: MultipartPart[]): Readable {
  async function* generate() {
    for (const part of parts) {
      yield Buffer.from(partHeader(part), "utf8");
      if (part.filename === undefined) yield Buffer.from(part.value ?? "", "utf8");
      else if (Buffer.isBuffer(part.data)) yield part.data;
      else if (part.data) for await (const chunk of part.data) yield chunk as Buffer;
      yield Buffer.from("\r\n", "utf8");
    }
    yield Buffer.from(`--${BOUNDARY}--\r\n`, "utf8");
  }
  return Readable.from(generate());
}

/** The common case: one `file` part plus optional text fields. */
export function fileUpload(
  filename: string,
  data: Buffer,
  options: { contentType?: string; fields?: Record<string, string>; fieldsFirst?: boolean } = {},
): Buffer {
  const fields = Object.entries(options.fields ?? {}).map(([name, value]) => ({ name, value }));
  const file = { name: "file", filename, contentType: options.contentType, data };
  return multipartBody(options.fieldsFirst ? [...fields, file] : [file, ...fields]);
}
