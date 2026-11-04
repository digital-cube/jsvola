import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { UPLOAD_OFFSET_HEADER, VOLA_FILE_ID_HEADER } from "@vol-a/core";
import { describe, expect, it } from "vitest";
import { useVolaUpload, VolaUploadButton, type VolaUploads } from "../src/index.js";
import { FakeServer, fileInfo, INSTANCE, json, keyringStatus, renderVola } from "./fake.js";

function uploadServer(box = { offset: 0 }): FakeServer {
  const server = new FakeServer();
  server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
  server.on("POST", /^\/vola\/files\/tickets\//, () =>
    json(fileInfo({ filename: "small.txt" }), 201),
  );
  server.on("POST", "/vola/uploads", ({ headers }) => {
    box.offset = 0;
    return new Response(null, {
      status: 201,
      headers: {
        location: "/vola/uploads/up-1",
        [UPLOAD_OFFSET_HEADER]: "0",
        "upload-length": headers.get("upload-length") ?? "0",
      },
    });
  });
  server.on(
    "HEAD",
    "/vola/uploads/up-1",
    () =>
      new Response(null, {
        status: 200,
        headers: { [UPLOAD_OFFSET_HEADER]: String(box.offset), "upload-length": "5000" },
      }),
  );
  server.on("PATCH", "/vola/uploads/up-1", async ({ body, headers }) => {
    const chunk = body as Blob;
    box.offset = Number(headers.get(UPLOAD_OFFSET_HEADER)) + chunk.size;
    const done = box.offset >= 5000;
    return new Response(null, {
      status: 204,
      headers: {
        [UPLOAD_OFFSET_HEADER]: String(box.offset),
        ...(done ? { [VOLA_FILE_ID_HEADER]: "019a0000-0000-7000-8000-00000000f1d2" } : {}),
      },
    });
  });
  return server;
}

let latest: VolaUploads | null = null;
function Probe() {
  latest = useVolaUpload();
  return <span data-testid="count">{latest.uploads.length}</span>;
}
/** The hook's last value. */
function hook(): VolaUploads {
  if (!latest) throw new Error("the Probe did not render");
  return latest;
}
const first = () => {
  const item = hook().uploads[0];
  if (!item) throw new Error("no upload");
  return item;
};

describe("useVolaUpload", () => {
  it("sends a small file as one multipart POST and a large one through /uploads, chunk by chunk", async () => {
    const server = uploadServer();
    renderVola(<Probe />, server, { resumableThreshold: 1000 });
    const small = new File(["hello"], "small.txt", { type: "text/plain" });
    const large = new File([new Uint8Array(5000)], "large.bin", {
      type: "application/octet-stream",
    });
    let items: Awaited<ReturnType<VolaUploads["upload"]>> = [];
    await act(async () => {
      items = await hook().upload([small, large], {
        instanceType: "tickets",
        instanceId: INSTANCE,
        folderPath: "docs",
        chunkSize: 2000,
      });
    });
    expect(items.map((i) => [i.name, i.status, i.resumable, i.fileId])).toEqual([
      ["small.txt", "done", false, fileInfo().id],
      ["large.bin", "done", true, "019a0000-0000-7000-8000-00000000f1d2"],
    ]);
    expect(server.of("POST", "/vola/files/tickets/").length).toBe(1);
    expect(server.of("POST", "/vola/uploads").length).toBe(1);
    expect(server.of("PATCH", "/vola/uploads/up-1").length).toBe(3); // 2000 + 2000 + 1000
    expect(hook().uploads.every((u) => u.uploaded === u.size)).toBe(true);
  });

  it("cancels a resumable upload and resumes it from the server's offset", async () => {
    const box = { offset: 0 };
    const server = uploadServer(box);
    let gate: (() => void) | null = null;
    let patches = 0;
    server.on("PATCH", "/vola/uploads/up-1", ({ body, headers }) => {
      patches += 1;
      const chunk = body as Blob;
      const offset = Number(headers.get(UPLOAD_OFFSET_HEADER)) + chunk.size;
      // the gated chunk never lands: the server's offset stays where it was
      if (patches !== 2) box.offset = offset;
      const answer = new Response(null, {
        status: 204,
        headers: {
          [UPLOAD_OFFSET_HEADER]: String(offset),
          ...(offset >= 5000
            ? { [VOLA_FILE_ID_HEADER]: "019a0000-0000-7000-8000-00000000f1d2" }
            : {}),
        },
      });
      if (patches === 2)
        return new Promise<Response>((resolve) => {
          gate = () => resolve(answer);
        });
      return answer;
    });
    renderVola(<Probe />, server, { resumableThreshold: 1000 });
    const large = new File([new Uint8Array(5000)], "large.bin");
    let finished: Awaited<ReturnType<VolaUploads["upload"]>> = [];
    let run: Promise<unknown> = Promise.resolve();
    act(() => {
      run = hook()
        .upload(large, { instanceType: "tickets", instanceId: INSTANCE, chunkSize: 2000 })
        .then((r) => {
          finished = r;
        });
    });
    await waitFor(() => expect(gate).not.toBeNull());
    act(() => hook().cancel(first().id));
    await run;
    expect(finished[0]?.status).toBe("cancelled");
    expect(finished[0]?.uploaded).toBe(2000);
    // the fingerprint survived in localStorage: resume HEADs the upload and continues from 2000
    expect(Object.keys(localStorage).some((k) => k.startsWith("vola-upload:"))).toBe(true);
    const before = server.of("PATCH", "/vola/uploads/up-1").length;
    await act(async () => {
      const resumed = await hook().resume(first().id);
      expect(resumed?.status).toBe("done");
    });
    expect(server.of("HEAD", "/vola/uploads/up-1").length).toBe(1);
    const after = server.of("PATCH", "/vola/uploads/up-1");
    expect(after.length - before).toBe(2);
    expect(after.at(-2)?.headers.get(UPLOAD_OFFSET_HEADER)).toBe("2000");
    expect(server.of("POST", "/vola/uploads").length).toBe(1);
    expect(Object.keys(localStorage).some((k) => k.startsWith("vola-upload:"))).toBe(false);
  });
});

describe("VolaUploadButton", () => {
  it("uploads the chosen files with the chosen encryption and lists them", async () => {
    const server = uploadServer();
    renderVola(
      <VolaUploadButton
        instanceType="tickets"
        instanceId={INSTANCE}
        encryptionChoices={["none", "tenant", "keyring"]}
      />,
      server,
      { resumableThreshold: 1000 },
    );
    await userEvent.selectOptions(screen.getByLabelText("Encryption"), "tenant");
    const input = screen.getByLabelText("Choose files") as HTMLInputElement;
    await userEvent.upload(input, new File(["hello"], "small.txt", { type: "text/plain" }));
    expect(await screen.findByText("Uploaded")).toBeTruthy();
    const call = server.of("POST", "/vola/files/tickets/")[0];
    expect(call?.headers.get("x-vola-encryption")).toBe("tenant");
    expect(screen.getByText("small.txt")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("small.txt")).toBeNull();
  });
});
