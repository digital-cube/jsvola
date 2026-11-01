import { describe, expect, it } from "vitest";
import {
  IMPLEMENTED_SHARE_SCOPES,
  SHARE_PASSWORD_HEADER,
  SHARE_SCOPES,
  ShareCreatedSchema,
  ShareCreateSchema,
  SharedFolderListingSchema,
  ShareTokenSchema,
  StorageStatsSchema,
  TenantStatsSchema,
} from "../src/index.js";

const UUID = "0192f3a0-1234-7000-8000-000000000001";

describe("share schemas", () => {
  it("accepts exactly one of file_id / folder", () => {
    expect(ShareCreateSchema.safeParse({ file_id: UUID }).success).toBe(true);
    expect(
      ShareCreateSchema.safeParse({
        folder: { instance_type: "tickets", instance_id: UUID, path: "/docs/q4/" },
      }).data?.folder?.path,
    ).toBe("docs/q4");
    expect(ShareCreateSchema.safeParse({}).success).toBe(false);
    expect(
      ShareCreateSchema.safeParse({
        file_id: UUID,
        folder: { instance_type: "tickets", instance_id: UUID, path: "docs" },
      }).success,
    ).toBe(false);
    // The root is not shareable; neither is a traversal.
    expect(
      ShareCreateSchema.safeParse({
        folder: { instance_type: "tickets", instance_id: UUID, path: "" },
      }).success,
    ).toBe(false);
    expect(
      ShareCreateSchema.safeParse({
        folder: { instance_type: "tickets", instance_id: UUID, path: "a/../b" },
      }).success,
    ).toBe(false);
  });

  it("defaults the scope to PUBLIC_LINK and knows which scopes are implemented", () => {
    expect(ShareCreateSchema.parse({ file_id: UUID }).scope).toBe("PUBLIC_LINK");
    expect(SHARE_SCOPES).toContain("EMAIL");
    expect(IMPLEMENTED_SHARE_SCOPES).toEqual(["PUBLIC_LINK"]);
    expect(ShareCreateSchema.safeParse({ file_id: UUID, scope: "FRIENDS" }).success).toBe(false);
    expect(ShareCreateSchema.safeParse({ file_id: UUID, max_downloads: 0 }).success).toBe(false);
    expect(ShareCreateSchema.safeParse({ file_id: UUID, password: "" }).success).toBe(false);
    expect(ShareCreateSchema.safeParse({ file_id: UUID, extra: 1 }).success).toBe(false);
  });

  it("validates the token shape and the created share", () => {
    const token = "A".repeat(43);
    expect(ShareTokenSchema.safeParse(token).success).toBe(true);
    expect(ShareTokenSchema.safeParse("short").success).toBe(false);
    expect(ShareTokenSchema.safeParse(`${"A".repeat(42)}+`).success).toBe(false);
    expect(
      ShareCreatedSchema.safeParse({
        id: UUID,
        tenant_id: UUID,
        file_id: UUID,
        folder_id: null,
        scope: "PUBLIC_LINK",
        has_password: false,
        expires_at: null,
        max_downloads: null,
        download_count: 0,
        created_by: null,
        created_at: "2026-11-01T10:00:00.000Z",
        revoked_at: null,
        encrypted: false,
        token,
        url: `http://localhost:8300/vola/s/${token}`,
      }).success,
    ).toBe(true);
    expect(SHARE_PASSWORD_HEADER).toBe("x-share-password");
  });

  it("validates a shared folder listing", () => {
    expect(
      SharedFolderListingSchema.safeParse({
        kind: "folder",
        share: { expires_at: null, max_downloads: 3, download_count: 1 },
        folder: { name: "docs", path: "" },
        subfolders: [{ name: "q4", path: "q4" }],
        files: [
          {
            id: UUID,
            filename: "a.txt",
            extension: "txt",
            size: 5,
            mime_type: "text/plain",
            kind: "text",
            created_at: "2026-11-01T10:00:00.000Z",
            updated_at: "2026-11-01T10:00:00.000Z",
            path: "a.txt",
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("stats schemas", () => {
  it("validates tenant and storage stats", () => {
    expect(
      TenantStatsSchema.safeParse({
        tenant_id: UUID,
        scope: "instance",
        instance_type: "tickets",
        instance_id: UUID,
        total_files: 2,
        total_bytes: 10,
        by_kind: { image: 2 },
        oldest_at: "2026-11-01T10:00:00.000Z",
        newest_at: "2026-11-01T10:00:00.000Z",
        computed_at: "2026-11-01T10:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      StorageStatsSchema.safeParse({
        scope: "deployment",
        tenant_id: null,
        files: 3,
        logical_bytes: 30,
        unique_blobs: 2,
        unique_bytes: 20,
        physical: {
          blobs: { bytes: 20, count: 2 },
          derived: { bytes: 0, count: 0 },
          uploads: { bytes: 0, count: 0 },
        },
        computed_at: "2026-11-01T10:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(TenantStatsSchema.safeParse({ tenant_id: UUID, scope: "galaxy" }).success).toBe(false);
  });
});
