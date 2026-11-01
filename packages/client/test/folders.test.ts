import { describe, expect, it } from "vitest";
import { FOLDER, jsonResponse, makeClient } from "./fake.js";

const T = "tickets";
const I = FOLDER.instance_id;
const base = `/vola/folders/${T}/${I}`;

describe("folders", () => {
  it("create, list (root and a path), rename, move, setDefaultKeyring, patch, delete", async () => {
    const { client, last } = makeClient((call) => {
      if (call.method === "GET") return jsonResponse({ folder: null, subfolders: [], files: [] });
      if (call.method === "DELETE") return jsonResponse({ folder: FOLDER, folders: 1, files: 0 });
      return jsonResponse(FOLDER, call.method === "POST" ? 201 : 200);
    });
    expect(await client.folders.create(T, I, "/docs/q 4/")).toEqual(FOLDER);
    expect(last().method).toBe("POST");
    expect(last().path).toBe(`${base}/docs/q%204`);

    await client.folders.list(T, I);
    expect(last().path).toBe(base);
    await client.folders.list(T, I, "docs");
    expect(last().path).toBe(`${base}/docs`);

    await client.folders.rename(T, I, "docs", "papers");
    expect(last().method).toBe("PATCH");
    expect(last().json).toEqual({ name: "papers" });
    await client.folders.move(T, I, "docs/q4", "");
    expect(last().json).toEqual({ parent_path: "" });
    await client.folders.setDefaultKeyring(T, I, "private", "me");
    expect(last().json).toEqual({ default_keyring: "me" });
    await client.folders.setDefaultKeyring(T, I, "private", null);
    expect(last().json).toEqual({ default_keyring: null });
    await client.folders.patch(T, I, "docs", { name: "x", parent_path: "y" }, { unlock: "t" });
    expect(last().json).toEqual({ name: "x", parent_path: "y" });
    expect(last().headers.get("x-vola-unlock")).toBe("t");

    const deleted = await client.folders.delete(T, I, "docs", { recursive: true });
    expect(deleted.folders).toBe(1);
    expect(last().method).toBe("DELETE");
    expect(last().url).toBe(`http://vola.test${base}/docs?recursive=1`);
    await client.folders.delete(T, I, "docs");
    expect(last().url).toBe(`http://vola.test${base}/docs`);
  });
});
