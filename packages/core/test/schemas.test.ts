import { describe, expect, it } from "vitest";
import {
  ErrorResponseSchema,
  errorResponse,
  LiveResponseSchema,
  REQUEST_ID_HEADER,
  ReadyResponseSchema,
} from "../src/index.js";

describe("@vol-a/core schemas", () => {
  it("builds and validates the error envelope", () => {
    const body = errorResponse("not_found", "route GET /x not found");
    expect(ErrorResponseSchema.parse(body)).toEqual({
      error: { code: "not_found", message: "route GET /x not found" },
    });
    expect(
      ErrorResponseSchema.safeParse({ error: { code: "NotFound", message: "" } }).success,
    ).toBe(false);
  });

  it("validates health responses", () => {
    expect(LiveResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(
      ReadyResponseSchema.parse({ status: "fail", checks: { database: "fail", redis: "ok" } }),
    ).toMatchObject({ status: "fail" });
    expect(ReadyResponseSchema.safeParse({ status: "ok", checks: {} }).success).toBe(false);
  });

  it("names the request id header", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });
});

describe("file schemas", () => {
  it("validates instance types and slugs", async () => {
    const { FileSlugSchema, InstanceTypeSchema } = await import("../src/index.js");
    expect(InstanceTypeSchema.safeParse("tickets").success).toBe(true);
    expect(InstanceTypeSchema.safeParse("user_profiles2").success).toBe(true);
    for (const bad of ["Tickets", "1tickets", "tick-ets", "", "a".repeat(101)]) {
      expect(InstanceTypeSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(FileSlugSchema.safeParse("avatar").success).toBe(true);
    expect(FileSlugSchema.safeParse("cover-image_2").success).toBe(true);
    for (const bad of ["Avatar", "-x", "_x", "", "a".repeat(101), "a/b"]) {
      expect(FileSlugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("describes a file info object without the encryption secrets", async () => {
    const { FILE_KINDS, FileInfoSchema, FileListSchema, PurgeResultSchema } = await import(
      "../src/index.js"
    );
    const info = {
      id: "01934a1e-7c6b-7000-8000-000000000001",
      tenant_id: "01934a1e-7c6b-7000-8000-000000000002",
      instance_type: "tickets",
      instance_id: "01934a1e-7c6b-7000-8000-000000000003",
      slug: null,
      hash: "a".repeat(64),
      size: 12,
      filename: "a.pdf",
      extension: "pdf",
      mime_type: "application/pdf",
      kind: "document",
      metadata: { source: "scan" },
      folder_id: null,
      parent_id: null,
      is_public: false,
      is_global_public: false,
      encryption: "none",
      enc_format: null,
      keyring_id: null,
      created_by: "igor",
      created_at: "2026-11-01T12:00:00.000Z",
      updated_at: "2026-11-01T12:00:00.000Z",
      deleted_at: null,
      deleted_by: null,
      last_accessed_at: null,
      last_accessed_by: null,
      processing_status: null,
    };
    expect(FileInfoSchema.parse(info)).toEqual(info);
    expect(FileInfoSchema.parse({ ...info, processing_status: "PENDING" }).processing_status).toBe(
      "PENDING",
    );
    expect(FileInfoSchema.safeParse({ ...info, processing_status: "QUEUED" }).success).toBe(false);
    expect(FileInfoSchema.safeParse({ ...info, kind: "picture" }).success).toBe(false);
    expect(FileInfoSchema.safeParse({ ...info, hash: "xyz" }).success).toBe(false);
    expect(FILE_KINDS).toContain("other");
    expect(FileListSchema.parse({ files: [info], next_cursor: null }).files).toHaveLength(1);
    expect(PurgeResultSchema.parse({ files: 1, blobs: 0 })).toEqual({ files: 1, blobs: 0 });
  });
});

describe("folder paths", () => {
  it("normalises a path and refuses traversal, empty segments and control characters", async () => {
    const { FOLDER_MAX_DEPTH, parseFolderPath, splitFilePath } = await import("../src/index.js");
    expect(parseFolderPath("docs/q4")).toEqual({
      ok: true,
      path: "docs/q4",
      segments: ["docs", "q4"],
    });
    expect(parseFolderPath("/docs/q4/")).toMatchObject({ ok: true, path: "docs/q4" });
    expect(parseFolderPath("")).toEqual({ ok: true, path: "", segments: [] });
    expect(parseFolderPath("/")).toEqual({ ok: true, path: "", segments: [] });
    expect(parseFolderPath("Rezultati 2026/Q4 — izveštaj.v2")).toMatchObject({ ok: true });
    for (const bad of [
      "..",
      "docs/../x",
      "../docs",
      "docs/..",
      ".",
      "a/./b",
      "a//b",
      "a\\b",
      "a\0b",
      "a\nb",
      "a\u0007b",
      `${"x".repeat(256)}`,
      Array.from({ length: FOLDER_MAX_DEPTH + 1 }, () => "d").join("/"),
    ]) {
      expect(parseFolderPath(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseFolderPath(Array.from({ length: FOLDER_MAX_DEPTH }, () => "d").join("/")).ok).toBe(
      true,
    );
    expect(parseFolderPath("x".repeat(255)).ok).toBe(true);
    expect(splitFilePath("docs/q4/report.pdf")).toEqual({
      folderPath: "docs/q4",
      filename: "report.pdf",
    });
    expect(splitFilePath("report.pdf")).toEqual({ folderPath: "", filename: "report.pdf" });
    expect(splitFilePath("/report.pdf/")).toEqual({ folderPath: "", filename: "report.pdf" });
  });

  it("validates the folder and file patch bodies", async () => {
    const { FilePatchSchema, FolderPatchSchema, FolderSegmentSchema } = await import(
      "../src/index.js"
    );
    expect(FolderPatchSchema.parse({ name: "renamed" })).toEqual({ name: "renamed" });
    expect(FolderPatchSchema.parse({ parent_path: "/a/b/" })).toEqual({ parent_path: "a/b" });
    expect(FolderPatchSchema.parse({ parent_path: "" })).toEqual({ parent_path: "" });
    for (const bad of [{}, { name: ".." }, { name: "a/b" }, { parent_path: "a/../b" }, { x: 1 }]) {
      expect(FolderPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(FolderSegmentSchema.safeParse("ok name").success).toBe(true);
    expect(FilePatchSchema.parse({ folder_path: "", is_public: true })).toEqual({
      folder_path: "",
      is_public: true,
    });
    for (const bad of [{}, { filename: "" }, { folder_path: ".." }, { is_public: "yes" }]) {
      expect(FilePatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
