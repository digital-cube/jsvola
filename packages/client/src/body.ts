import { randomHex } from "./env.js";

/** Bytes that are all in memory (or in a `Blob`): they can be sized and sliced, so they can be resumed. */
export type ByteSource = Blob | Uint8Array | ArrayBuffer;
/** Bytes that arrive over time: a web `ReadableStream`, or anything async-iterable (a Node `Readable`, a generator). */
export type StreamSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
/** What an upload accepts. A Node `Buffer` is a `Uint8Array`; a `File` is a `Blob` that also carries its name. */
export type UploadSource = ByteSource | StreamSource;

export function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

export function isStreamSource(value: unknown): value is StreamSource {
  if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    !isBlob(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    Symbol.asyncIterator in value
  );
}

/** The byte length of an in-memory source. */
export function sizeOf(source: ByteSource): number {
  if (isBlob(source)) return source.size;
  return source.byteLength;
}

/** `source[start, end)` as something `fetch` sends as a body. */
export function sliceOf(source: ByteSource, start: number, end: number): Blob | Uint8Array {
  if (isBlob(source)) return source.slice(start, end);
  if (source instanceof ArrayBuffer) return new Uint8Array(source, start, end - start);
  return source.subarray(start, end);
}

/** An in-memory source as a `Blob` of `type`. */
export function toBlob(source: ByteSource, type?: string): Blob {
  if (isBlob(source))
    return type && source.type !== type ? source.slice(0, source.size, type) : source;
  // A fresh copy: `Blob` takes the view as is, and a `Buffer` from a pool would drag its neighbours in.
  const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  return new Blob([bytes.slice()], type ? { type } : undefined);
}

/** The name a `File` carries, when the source is one. */
export function nameOf(source: UploadSource): string | undefined {
  if (isBlob(source) && "name" in source && typeof source.name === "string") return source.name;
  return undefined;
}

/** The MIME type a `Blob` carries, when it has one. */
export function typeOf(source: UploadSource): string | undefined {
  return isBlob(source) && source.type !== "" ? source.type : undefined;
}

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  source: UploadSource;
}

export interface MultipartBody {
  body: BodyInit;
  /** Set when the body is a stream the SDK framed itself; `undefined` lets `fetch` frame the `FormData`. */
  contentType: string | undefined;
  /** `true`: the body is a `ReadableStream` (the request needs `duplex: "half"`). */
  streaming: boolean;
}

/** A `"` or a line break in a filename would end the header early; percent-encode them. */
function quote(value: string): string {
  return value.replace(/["\r\n]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

async function* chunksOf(source: StreamSource): AsyncGenerator<Uint8Array> {
  if (typeof ReadableStream !== "undefined" && source instanceof ReadableStream) {
    const reader = source.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of source as AsyncIterable<Uint8Array>) yield chunk;
  }
}

/**
 * The `multipart/form-data` body of an upload: the text `fields` FIRST, in order (the server
 * reads the encryption mode and the folder before the file part starts), then the one file
 * part. An in-memory source becomes a `FormData` (the platform frames it); a stream is framed
 * here and sent as a `ReadableStream`, so a file of any size goes up without being read into
 * memory (Node; in a browser, give a `File` or a `Blob`).
 */
export function multipartBody(fields: [string, string][], file: MultipartFile): MultipartBody {
  if (!isStreamSource(file.source)) {
    const form = new FormData();
    for (const [name, value] of fields) form.append(name, value);
    form.append(file.field, toBlob(file.source, file.contentType), file.filename);
    return { body: form, contentType: undefined, streaming: false };
  }
  const boundary = `----VolaFormBoundary${randomHex(12)}`;
  const encoder = new TextEncoder();
  const head =
    fields
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`,
      )
      .join("") +
    `--${boundary}\r\nContent-Disposition: form-data; name="${quote(file.field)}"; filename="${quote(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const source = file.source;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(head));
      try {
        for await (const chunk of chunksOf(source)) controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.enqueue(encoder.encode(tail));
      controller.close();
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, streaming: true };
}
