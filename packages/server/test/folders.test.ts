import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import nodeHttp from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileInfoSchema,
  FolderDeleteResultSchema,
  FolderInfoSchema,
  FolderListingSchema,
} from "@vol-a/core";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files, folders } from "../src/db/schema.js";
import { parentPathOf } from "../src/services/folders.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { bearer, type Fixture, mintKey, setupFixture, testDatabase, truncate } from "./helpers.js";
import { httpClient } from "./http.js";

const handle = testDatabase(5);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let storage: FilesystemBackend;
let http: ReturnType<typeof httpClient>;
let other: { tenantId: string; key: string };

const TYPE = "tickets";
const F = (instanceId: string, path = "") =>
  `/vola/folders/${TYPE}/${instanceId}${path ? `/${path}` : ""}`;
const P = (instanceId: string, path: string) => `/vola/files/${TYPE}/${instanceId}/path/${path}`;

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-folders-"));
  storage = new FilesystemBackend(root);
  fx = await setupFixture(handle, { storage });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other-full", "live", [
    "files:read",
    "files:write",
    "folders:read",
    "folders:write",
  ]);
  other = { tenantId: tenant.id, key: key.key };
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

const livePaths = async (instanceId: string) =>
  (
    await handle.db
      .select({ path: folders.path })
      .from(folders)
      .where(and(eq(folders.instanceId, instanceId), isNull(folders.deletedAt)))
      .orderBy(folders.path)
  ).map((row) => row.path);

describe("folder create", () => {
  it("creates the whole chain of parents, idempotently (201 new, 200 existing)", async () => {
    const instanceId = randomUUID();
    const first = await http.post(F(instanceId, "docs/reports/q4"), { "x-user-id": "igor" });
    expect(first.statusCode, first.body).toBe(201);
    const leaf = FolderInfoSchema.parse(first.json());
    expect(leaf).toMatchObject({
      tenant_id: fx.tenant.id,
      instance_type: TYPE,
      instance_id: instanceId,
      name: "q4",
      path: "docs/reports/q4",
      default_keyring_id: null,
      created_by: "igor",
      deleted_at: null,
    });
    expect(await livePaths(instanceId)).toEqual(["docs", "docs/reports", "docs/reports/q4"]);

    const again = await http.post(F(instanceId, "docs/reports/q4"));
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(leaf.id);
    expect(await livePaths(instanceId)).toHaveLength(3);

    // The parents are linked, and a trailing slash or a leading one changes nothing.
    const reports = await http.post(F(instanceId, "docs/reports/"));
    expect(reports.statusCode).toBe(200);
    expect(reports.json().parent_id).toBe((await http.get(F(instanceId, "docs"))).json().folder.id);
    expect(leaf.parent_id).toBe(reports.json().id);
    expect(parentPathOf("docs/reports/q4")).toBe("docs/reports");
    expect(parentPathOf("docs")).toBe("");
  });

  it("refuses empty, oversized, backslash and control-character segments with 422", async () => {
    const instanceId = randomUUID();
    const bad = [
      "a//b",
      `a${encodeURIComponent("\\")}b`,
      `a${encodeURIComponent("\u0001")}b`,
      "x".repeat(256),
      Array.from({ length: 33 }, (_, i) => `d${i}`).join("/"),
    ];
    for (const path of bad) {
      const response = await http.post(F(instanceId, path));
      expect(response.statusCode, path).toBe(422);
      expect(response.json().error.code, path).toBe("validation_error");
    }
    // The root is not a folder to create.
    const rootPost = await http.post(`${F(instanceId)}/`);
    expect(rootPost.statusCode).toBe(422);
    expect(await livePaths(instanceId)).toEqual([]);
  });

  it("refuses traversal (`..`, `%2e%2e`, `.`) in the URL over a real socket and in body fields", async () => {
    // The inject client resolves dot segments like a browser would; a raw request does not,
    // so these reach the handler as `..` and must be refused there.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const raw = (method: string, path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = nodeHttp.request(
          { host: "127.0.0.1", port, path, method, headers: { ...bearer(fx.full.key) } },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        request.on("error", reject);
        request.end();
      });
    const instanceId = randomUUID();
    await http.upload(Buffer.from("r"), "rootfile.txt", { instanceId });
    for (const path of ["docs/../escape", "%2e%2e/escape", "..", "a/%2e/b", "x/./y"]) {
      const response = await raw("POST", F(instanceId, path));
      expect(response.status, path).toBe(422);
      expect(JSON.parse(response.body).error.code).toBe("validation_error");
    }
    for (const path of [
      "../rootfile.txt",
      "deep/%2e%2e/rootfile.txt",
      "%2e%2e/%2e%2e/rootfile.txt",
    ]) {
      const response = await raw("GET", P(instanceId, path));
      expect(response.status, path).toBe(422);
    }
    expect(await livePaths(instanceId)).toEqual([]);

    for (const folder_path of ["../x", "a/../b", "..", "."]) {
      const { response } = await http.upload(Buffer.from("t"), "t.txt", {
        instanceId,
        fields: { folder_path },
      });
      expect(response.statusCode, folder_path).toBe(422);
    }
    await http.post(F(instanceId, "a"));
    expect((await http.patch(F(instanceId, "a"), { parent_path: "../up" })).statusCode).toBe(422);
    expect((await http.patch(F(instanceId, "a"), { name: ".." })).statusCode).toBe(422);
    expect(await livePaths(instanceId)).toEqual(["a"]);
  });

  it("needs folders:write (a files:read key gets 403 with the scope named)", async () => {
    const response = await http.post(F(randomUUID(), "x"), {}, fx.readOnly.key);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.required).toEqual(["folders:write"]);
  });
});

describe("folder listing", () => {
  it("lists one level: the root, then a folder with its direct subfolders and files", async () => {
    const instanceId = randomUUID();
    await http.post(F(instanceId, "attachments/2026"));
    await http.post(F(instanceId, "attachments/2025"));
    await http.post(F(instanceId, "zeta"));
    await http.upload(Buffer.from("root"), "readme.txt", { instanceId });
    await http.upload(Buffer.from("deep"), "deep.txt", {
      instanceId,
      fields: { folder_path: "attachments/2026" },
    });
    await http.upload(Buffer.from("a"), "b.txt", {
      instanceId,
      fields: { folder_path: "attachments" },
    });
    await http.upload(Buffer.from("a"), "a.txt", {
      instanceId,
      fields: { folder_path: "attachments" },
    });

    const rootListing = await http.get(F(instanceId));
    expect(rootListing.statusCode).toBe(200);
    const parsedRoot = FolderListingSchema.parse(rootListing.json());
    expect(parsedRoot.folder).toBeNull();
    expect(parsedRoot.subfolders.map((f) => f.path)).toEqual(["attachments", "zeta"]);
    expect(parsedRoot.files.map((f) => f.filename)).toEqual(["readme.txt"]);
    const slashRoot = await http.get(`${F(instanceId)}/`);
    expect(slashRoot.json()).toEqual(rootListing.json());

    const listing = await http.get(F(instanceId, "attachments"));
    const parsed = FolderListingSchema.parse(listing.json());
    expect(parsed.folder?.path).toBe("attachments");
    expect(parsed.subfolders.map((f) => f.path)).toEqual(["attachments/2025", "attachments/2026"]);
    expect(parsed.files.map((f) => f.filename)).toEqual(["a.txt", "b.txt"]);
    expect(parsed.files[0]?.folder_id).toBe(parsed.folder?.id);

    expect((await http.get(F(instanceId, "ghost"))).statusCode).toBe(404);
    expect((await http.get(F(instanceId, "ghost"))).json().error.code).toBe("folder_not_found");
    expect((await http.get(F(instanceId, "attachments"), {}, fx.readOnly.key)).statusCode).toBe(
      403,
    );
  });
});

describe("folder rename and move", () => {
  it("renames the leaf and rewrites every descendant path in one go", async () => {
    const instanceId = randomUUID();
    await http.post(F(instanceId, "docs/reports/q4"));
    await http.post(F(instanceId, "docs/reports/q3"));
    await http.post(F(instanceId, "docs_old"));
    await http.post(F(instanceId, "docs%25")); // a LIKE-special sibling that must not move
    const { response: up } = await http.upload(Buffer.from("q4"), "report.pdf", {
      instanceId,
      fields: { folder_path: "docs/reports/q4" },
    });

    const renamed = await http.patch(F(instanceId, "docs"), { name: "documents" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "documents", path: "documents", parent_id: null });
    expect(await livePaths(instanceId)).toEqual([
      "docs%",
      "docs_old",
      "documents",
      "documents/reports",
      "documents/reports/q3",
      "documents/reports/q4",
    ]);
    // The file follows its folder, by path and by id.
    const byPath = await http.get(P(instanceId, "documents/reports/q4/report.pdf"));
    expect(byPath.statusCode).toBe(200);
    expect(byPath.body).toBe("q4");
    expect((await http.get(P(instanceId, "docs/reports/q4/report.pdf"))).statusCode).toBe(404);
    expect(up.json().folder_id).toBe(
      (await http.get(F(instanceId, "documents/reports/q4"))).json().folder.id,
    );

    // A deeper rename only touches its subtree; the same name is a no-op.
    const q = await http.patch(F(instanceId, "documents/reports"), { name: "r" });
    expect(q.json().path).toBe("documents/reports".replace("reports", "r"));
    expect(await livePaths(instanceId)).toContain("documents/r/q4");
    const same = await http.patch(F(instanceId, "documents/r"), { name: "r" });
    expect(same.statusCode).toBe(200);
  });

  it("answers 409 folder_exists on a rename or move collision and 422 on a bad name", async () => {
    const instanceId = randomUUID();
    await http.post(F(instanceId, "a/x"));
    await http.post(F(instanceId, "b/x"));
    await http.post(F(instanceId, "a/y"));
    const collide = await http.patch(F(instanceId, "a/y"), { name: "x" });
    expect(collide.statusCode).toBe(409);
    expect(collide.json().error.code).toBe("folder_exists");
    const move = await http.patch(F(instanceId, "a/x"), { parent_path: "b" });
    expect(move.statusCode).toBe(409);
    expect(move.json().error.code).toBe("folder_exists");
    for (const body of [
      { name: ".." },
      { name: "a/b" },
      {},
      { bogus: 1 },
      { parent_path: "../z" },
    ]) {
      const response = await http.patch(F(instanceId, "a/y"), body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await http.patch(F(instanceId, "ghost"), { name: "x" })).statusCode).toBe(404);
    expect((await http.patch(`${F(instanceId)}/`, { name: "x" })).statusCode).toBe(422);
    expect(await livePaths(instanceId)).toEqual(["a", "a/x", "a/y", "b", "b/x"]);
  });

  it("moves a subtree under another parent (created when missing), or to the root", async () => {
    const instanceId = randomUUID();
    await http.post(F(instanceId, "src/lib/util"));
    await http.upload(Buffer.from("u"), "u.ts", {
      instanceId,
      fields: { folder_path: "src/lib/util" },
    });

    const moved = await http.patch(F(instanceId, "src/lib"), { parent_path: "archive/2026" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ path: "archive/2026/lib", name: "lib" });
    expect(moved.json().parent_id).toBe(
      (await http.get(F(instanceId, "archive/2026"))).json().folder.id,
    );
    expect(await livePaths(instanceId)).toEqual([
      "archive",
      "archive/2026",
      "archive/2026/lib",
      "archive/2026/lib/util",
      "src",
    ]);
    expect((await http.get(P(instanceId, "archive/2026/lib/util/u.ts"))).statusCode).toBe(200);

    // Move and rename at once, to the root.
    const toRoot = await http.patch(F(instanceId, "archive/2026/lib"), {
      parent_path: "",
      name: "library",
    });
    expect(toRoot.json()).toMatchObject({ path: "library", parent_id: null });
    expect(await livePaths(instanceId)).toContain("library/util");

    // Not into itself or below itself.
    const self = await http.patch(F(instanceId, "library"), { parent_path: "library/util" });
    expect(self.statusCode).toBe(422);
    const same = await http.patch(F(instanceId, "library"), { parent_path: "library" });
    expect(same.statusCode).toBe(422);
    // Not beyond the depth limit.
    const deep = Array.from({ length: 31 }, (_, i) => `d${i}`).join("/");
    await http.post(F(instanceId, deep));
    const tooDeep = await http.patch(F(instanceId, "library"), { parent_path: deep });
    expect(tooDeep.statusCode).toBe(422);
  });
});

describe("folder delete", () => {
  it("refuses a non-empty folder without recursive, soft-deletes the whole subtree with it", async () => {
    const instanceId = randomUUID();
    await http.post(F(instanceId, "docs/a"));
    await http.post(F(instanceId, "docs/b/c"));
    const { response: top } = await http.upload(Buffer.from("top"), "file.txt", {
      instanceId,
      fields: { folder_path: "docs" },
    });
    await http.upload(Buffer.from("deep"), "deep.bin", {
      instanceId,
      fields: { folder_path: "docs/b/c" },
    });
    await http.upload(Buffer.from("root"), "root.txt", { instanceId });

    const refused = await http.del(F(instanceId, "docs"));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("folder_not_empty");
    const onlyFiles = await http.del(F(instanceId, "docs/b/c"));
    expect(onlyFiles.statusCode).toBe(409);
    expect(await livePaths(instanceId)).toHaveLength(4);

    const deleted = await http.del(`${F(instanceId, "docs")}?recursive=1`, {
      "x-user-id": "deleter",
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const result = FolderDeleteResultSchema.parse(deleted.json());
    expect(result).toMatchObject({ folders: 4, files: 2 });
    expect(result.folder.deleted_at).not.toBeNull();
    expect(result.folder.deleted_by).toBe("deleter");
    expect(await livePaths(instanceId)).toEqual([]);
    const [gone] = await handle.db.select().from(files).where(eq(files.id, top.json().id));
    expect(gone?.deletedAt).not.toBeNull();
    expect(gone?.deletedBy).toBe("deleter");
    // The root file is untouched; the folder and its files are gone from every lookup.
    expect((await http.get(P(instanceId, "root.txt"))).statusCode).toBe(200);
    expect((await http.get(F(instanceId, "docs"))).statusCode).toBe(404);
    expect((await http.del(F(instanceId, "docs"))).statusCode).toBe(404);
    expect((await http.get(P(instanceId, "docs/file.txt"))).statusCode).toBe(404);
    // The path is free again: a new folder, a new id.
    const recreated = await http.post(F(instanceId, "docs"));
    expect(recreated.statusCode).toBe(201);
    expect(recreated.json().id).not.toBe(result.folder.id);
    expect((await http.get(F(instanceId, "docs"))).json().files).toEqual([]);
  });

  it("deletes an empty folder without recursive and answers 422 for the root", async () => {
    const instanceId = randomUUID();
    await http.post(F(instanceId, "lonely"));
    const deleted = await http.del(F(instanceId, "lonely"));
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ folders: 1, files: 0 });
    expect((await http.del(`${F(instanceId)}/`)).statusCode).toBe(422);
  });
});

describe("files in folders", () => {
  it("uploads into folder_path (auto-created) or folder_id, with the collision rename per folder", async () => {
    const instanceId = randomUUID();
    const a = await http.upload(Buffer.from("1"), "report.pdf", {
      instanceId,
      fields: { folder_path: "auto/created/here" },
      contentType: "application/pdf",
    });
    expect(a.response.statusCode, a.response.body).toBe(201);
    expect(await livePaths(instanceId)).toEqual(["auto", "auto/created", "auto/created/here"]);
    const folderId = a.response.json().folder_id as string;
    expect(folderId).toBe((await http.get(F(instanceId, "auto/created/here"))).json().folder.id);

    const b = await http.upload(Buffer.from("2"), "report.pdf", {
      instanceId,
      fields: { folder_id: folderId },
    });
    expect(b.response.json().filename).toBe("report (1).pdf");
    expect(b.response.json().folder_id).toBe(folderId);
    // The same name in another folder, and in the root, is free.
    const c = await http.upload(Buffer.from("3"), "report.pdf", {
      instanceId,
      fields: { folder_path: "auto" },
    });
    expect(c.response.json().filename).toBe("report.pdf");
    const d = await http.upload(Buffer.from("4"), "report.pdf", { instanceId });
    expect(d.response.json().filename).toBe("report.pdf");
    expect(d.response.json().folder_id).toBeNull();
    const e = await http.upload(Buffer.from("5"), "report.pdf", {
      instanceId,
      fields: { folder_path: "/" },
    });
    expect(e.response.json().filename).toBe("report (1).pdf");
    const f = await http.upload(Buffer.from("6"), "x.txt", {
      instanceId,
      fields: { folder_id: "" },
    });
    expect(f.response.json().folder_id).toBeNull();
    // Another tenant's folder id is not a folder here.
    const theirs = await http.post(F(instanceId, "theirs"), {}, other.key);
    const g = await http.upload(Buffer.from("7"), "x.txt", {
      instanceId,
      fields: { folder_id: theirs.json().id },
    });
    expect(g.response.statusCode).toBe(404);
  });

  it("downloads by path with the same headers, Range and HEAD as by id", async () => {
    const instanceId = randomUUID();
    const data = randomBytes(5000);
    const { response: up } = await http.upload(data, "Račun 2026.pdf", {
      instanceId,
      fields: { folder_path: "deep/nested" },
      contentType: "application/pdf",
    });
    const byPath = await http.get(P(instanceId, encodeURI("deep/nested/Račun 2026.pdf")));
    expect(byPath.statusCode, byPath.body).toBe(200);
    expect(byPath.rawPayload.equals(data)).toBe(true);
    expect(byPath.headers.etag).toBe(`"${up.json().hash}"`);
    expect(byPath.headers["content-disposition"]).toContain(
      "filename*=UTF-8''Ra%C4%8Dun%202026.pdf",
    );
    const head = await http.head(P(instanceId, encodeURI("deep/nested/Račun 2026.pdf")));
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe("5000");
    expect(head.body).toBe("");
    const range = await http.get(P(instanceId, encodeURI("deep/nested/Račun 2026.pdf")), {
      range: "bytes=10-19",
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.equals(data.subarray(10, 20))).toBe(true);

    const rootFile = await http.upload(Buffer.from("root"), "rootfile.txt", { instanceId });
    expect((await http.get(P(instanceId, "rootfile.txt"))).body).toBe("root");
    expect((await http.get(P(instanceId, "/rootfile.txt"))).body).toBe("root");
    expect(rootFile.response.statusCode).toBe(201);
    for (const missing of [
      "nope/missing.txt",
      "deep/nested/missing.pdf",
      "deep/nested",
      "deep",
      "",
    ]) {
      const response = await http.get(P(instanceId, missing));
      expect(response.statusCode, missing).toBe(404);
    }
    expect((await http.get(P(instanceId, "a%5Cb/x.txt"))).statusCode).toBe(422);
    expect((await http.get(P(instanceId, "a//x.txt"))).statusCode).toBe(404);
    expect((await http.get(P(instanceId, "rootfile.txt"), {}, fx.readOnly.key)).statusCode).toBe(
      200,
    );
  });

  it('moves a file with PATCH folder_path (auto-created; "" is the root) and renames it with collision checks', async () => {
    const instanceId = randomUUID();
    const { response: up } = await http.upload(Buffer.from("m"), "move.txt", { instanceId });
    const id = up.json().id as string;
    const url = `/vola/files/${TYPE}/${instanceId}/${id}`;

    const moved = await http.patch(url, { folder_path: "inbox/2026" });
    expect(moved.statusCode, moved.body).toBe(200);
    const info = FileInfoSchema.parse(moved.json());
    expect(info.folder_id).toBe((await http.get(F(instanceId, "inbox/2026"))).json().folder.id);
    expect((await http.get(P(instanceId, "inbox/2026/move.txt"))).statusCode).toBe(200);
    expect((await http.get(P(instanceId, "move.txt"))).statusCode).toBe(404);
    expect(new Date(info.updated_at).getTime()).toBeGreaterThan(
      new Date(up.json().updated_at).getTime(),
    );

    // A taken name in the target folder is a conflict, moving or renaming.
    await http.upload(Buffer.from("x"), "move.txt", { instanceId });
    const back = await http.patch(url, { folder_path: "" });
    expect(back.statusCode).toBe(409);
    expect(back.json().error.code).toBe("file_exists");
    await http.upload(Buffer.from("x"), "taken.txt", {
      instanceId,
      fields: { folder_path: "inbox/2026" },
    });
    const rename = await http.patch(url, { filename: "taken.txt" });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error.code).toBe("file_exists");
    // A free name goes through, the extension follows; the same name is a no-op.
    const renamed = await http.patch(url, { filename: "../renamed.md" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ filename: "renamed.md", extension: "md" });
    expect((await http.patch(url, { filename: "renamed.md" })).statusCode).toBe(200);
    expect((await http.get(P(instanceId, "inbox/2026/renamed.md"))).statusCode).toBe(200);
    // Move and rename at once, to the root.
    const both = await http.patch(url, { folder_path: "/", filename: "final.md" });
    expect(both.json()).toMatchObject({ folder_id: null, filename: "final.md" });

    for (const body of [
      {},
      { folder_path: "../x" },
      { filename: "" },
      { extra: 1 },
      { is_public: "yes" },
    ]) {
      const response = await http.patch(url, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await http.patch(url, { folder_path: "x" }, {}, fx.readOnly.key)).statusCode).toBe(403);
    expect(
      (await http.patch(`/vola/files/${TYPE}/${instanceId}/${randomUUID()}`, { filename: "x" }))
        .statusCode,
    ).toBe(404);
  });

  it("keeps a folder's files invisible to a folder soft-delete survivor list and to the file list after delete", async () => {
    const instanceId = randomUUID();
    await http.upload(Buffer.from("1"), "a.txt", { instanceId, fields: { folder_path: "f" } });
    await http.del(`${F(instanceId, "f")}?recursive=true`);
    const list = await http.get(`/vola/files/${TYPE}/${instanceId}`);
    expect(list.json().files).toEqual([]);
    const withDeleted = await http.get(`/vola/files/${TYPE}/${instanceId}?include_deleted=1`);
    expect(withDeleted.json().files).toHaveLength(1);
  });
});

describe("tenant isolation of folders", () => {
  it("hides another tenant's folders and files behind 404 on every route", async () => {
    const instanceId = randomUUID();
    await http.post(F(instanceId, "secret/inner"));
    await http.upload(Buffer.from("s"), "s.txt", { instanceId, fields: { folder_path: "secret" } });
    const o = other.key;
    expect((await http.get(F(instanceId, "secret"), {}, o)).statusCode).toBe(404);
    expect((await http.get(F(instanceId), {}, o)).json()).toEqual({
      folder: null,
      subfolders: [],
      files: [],
    });
    expect((await http.patch(F(instanceId, "secret"), { name: "x" }, {}, o)).statusCode).toBe(404);
    expect((await http.del(`${F(instanceId, "secret")}?recursive=1`, {}, o)).statusCode).toBe(404);
    expect((await http.get(P(instanceId, "secret/s.txt"), {}, o)).statusCode).toBe(404);
    // The same path is a different folder for the other tenant.
    const theirs = await http.post(F(instanceId, "secret"), {}, o);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().tenant_id).toBe(other.tenantId);
    expect((await http.get(F(instanceId, "secret"), {}, o)).json().subfolders).toEqual([]);
    expect(
      (await http.get(F(instanceId, "secret")))
        .json()
        .subfolders.map((f: { path: string }) => f.path),
    ).toEqual(["secret/inner"]);
    // An admin key works in the tenant it selects.
    const admin = await http.get(
      F(instanceId, "secret"),
      { "x-tenant-slug": fx.tenant.slug },
      fx.admin.key,
    );
    expect(admin.statusCode).toBe(200);
    expect(admin.json().files.map((f: { filename: string }) => f.filename)).toEqual(["s.txt"]);
    expect((await http.get(F(instanceId, "secret"), {}, fx.admin.key)).statusCode).toBe(400);
  });
});
