import { describe, expect, it } from "vitest";
import {
  decodeTusMetadata,
  encodeTusMetadata,
  TUS_EXTENSIONS,
  TUS_VERSION,
  UPLOAD_META_KEYS,
} from "../src/index.js";

describe("tus Upload-Metadata codec", () => {
  it("round-trips UTF-8 values and keeps an empty value as a bare key", () => {
    const header = encodeTusMetadata({
      [UPLOAD_META_KEYS.filename]: "Račun № 7.pdf",
      [UPLOAD_META_KEYS.instanceType]: "tickets",
      [UPLOAD_META_KEYS.slug]: "",
      [UPLOAD_META_KEYS.folderPath]: undefined,
      [UPLOAD_META_KEYS.parentId]: null,
    });
    expect(header).toBe("filename UmHEjXVuIOKEliA3LnBkZg==,instance_type dGlja2V0cw==,slug");
    expect(decodeTusMetadata(header)).toEqual({
      filename: "Račun № 7.pdf",
      instance_type: "tickets",
      slug: "",
    });
  });

  it("decodes what tus-js-client sends (spaces around commas, no padding issues) and an empty header", () => {
    expect(decodeTusMetadata("filename ZmlsZQ==, filetype aW1hZ2UvcG5n")).toEqual({
      filename: "file",
      filetype: "image/png",
    });
    expect(decodeTusMetadata(undefined)).toEqual({});
    expect(decodeTusMetadata("")).toEqual({});
  });

  it("rejects a repeated key, a key with whitespace and a value that is not base64", () => {
    expect(decodeTusMetadata("a Yg==,a Yw==")).toBeNull();
    expect(decodeTusMetadata("a b c")).toBeNull();
    expect(decodeTusMetadata("filename !!!")).toBeNull();
    expect(decodeTusMetadata("filename Yg=")).toBeNull();
  });

  it("names the protocol", () => {
    expect(TUS_VERSION).toBe("1.0.0");
    expect(TUS_EXTENSIONS).toEqual(["creation", "termination", "expiration"]);
  });
});
