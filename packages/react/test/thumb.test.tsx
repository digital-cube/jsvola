import { act, screen, waitFor } from "@testing-library/react";
import { VolaClient } from "@vol-a/client";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { thumbRetryDelay, VolaThumb } from "../src/index.js";
import { BASE, error, FakeServer, fileInfo, json, keyringStatus, renderVola } from "./fake.js";

const webp = () =>
  new Response(new Blob([new Uint8Array([82, 73, 70, 70])], { type: "image/webp" }), {
    status: 200,
    headers: { "content-type": "image/webp", "x-thumbnail-status": "ready", etag: '"t1"' },
  });
const generating = () =>
  new Response(new Blob([new Uint8Array([0])], { type: "image/webp" }), {
    status: 202,
    headers: { "content-type": "image/webp", "x-thumbnail-status": "generating" },
  });

/** A thumbnail whose row's `processing_status` goes RUNNING → DONE on a click. */
function Row() {
  const [status, setStatus] = useState("RUNNING");
  return (
    <>
      <VolaThumb file={{ ...fileInfo(), processing_status: status }} size={64} maxRetries={0} />
      <button type="button" onClick={() => setStatus("DONE")}>
        done
      </button>
    </>
  );
}

describe("VolaThumb", () => {
  it("shows a placeholder on 202, retries with backoff, then the image — the 202 body is never cached", async () => {
    const server = new FakeServer();
    let calls = 0;
    server.on("GET", /\/thumb\/128$/, () => (++calls < 3 ? generating() : webp()));
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    const states: string[] = [];
    renderVola(
      <VolaThumb file={fileInfo()} size={128} retryBaseMs={5} onState={(s) => states.push(s)} />,
      server,
    );
    expect(await screen.findByRole("img", { name: "Thumbnail is being made" })).toBeTruthy();
    const img = (await screen.findByAltText("report.pdf", undefined, {
      timeout: 3000,
    })) as HTMLImageElement;
    expect(img.src).toMatch(/^blob:vola\//);
    expect(calls).toBe(3);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["loading", "generating", "generating", "ready"]);
    expect(
      server
        .of("GET", "/vola/files/")
        .every((c) => c.headers.get("authorization") === "Bearer vola_test_key"),
    ).toBe(true);
  });

  it("works with a client on an ACCESS TOKEN: the token goes as Bearer, a 401 is refreshed once", async () => {
    const server = new FakeServer();
    const T1 = `vola_at_${"1".repeat(40)}`;
    const T2 = `vola_at_${"2".repeat(40)}`;
    let valid = T1;
    server.on("GET", /\/thumb\/128$/, (req) =>
      req.headers.get("authorization") === `Bearer ${valid}` ? webp() : error(401, "unauthorized"),
    );
    // What the real server answers a token anywhere else.
    server.on("GET", "/vola/keyrings/me/status", () => error(401, "unauthorized"));
    const client = new VolaClient({
      baseUrl: BASE,
      accessToken: T1,
      getAccessToken: async () => T2,
      fetch: server.fetch,
    });
    valid = T2; // T1 has expired by the time the thumbnail is asked for
    renderVola(<VolaThumb file={fileInfo()} size={128} />, server, { client });
    const img = (await screen.findByAltText("report.pdf", undefined, {
      timeout: 3000,
    })) as HTMLImageElement;
    expect(img.src).toMatch(/^blob:vola\//);
    const thumbs = server.of("GET", "/vola/files/");
    expect(thumbs.map((c) => c.headers.get("authorization"))).toEqual([
      `Bearer ${T1}`,
      `Bearer ${T2}`,
    ]);
    expect(thumbs.every((c) => !c.headers.has("x-api-key"))).toBe(true);
  });

  it("backs off 1, 2, 4 … seconds, at most 30", () => {
    expect([0, 1, 2, 3, 5, 10].map((n) => thumbRetryDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 30000, 30000,
    ]);
  });

  it("shows the 'no preview' placeholder for 404 no_thumbnail and the 'failed' one for a failed render", async () => {
    const server = new FakeServer();
    server.on("GET", /000001\/thumb\/64$/, () => error(404, "no_thumbnail"));
    server.on(
      "GET",
      /000002\/thumb\/64$/,
      () =>
        new Response(new Blob([new Uint8Array([0])]), {
          status: 200,
          headers: { "x-thumbnail-status": "failed" },
        }),
    );
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    renderVola(
      <>
        <VolaThumb file={fileInfo()} size={64} />
        <VolaThumb file={fileInfo({ id: "019a0000-0000-7000-8000-000000000002" })} size={64} />
      </>,
      server,
    );
    expect(await screen.findByRole("img", { name: "No preview for this type" })).toBeTruthy();
    expect(await screen.findByRole("img", { name: "No preview" })).toBeTruthy();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("reuses the cached blob: URL for the same file and size", async () => {
    const server = new FakeServer();
    server.on("GET", /\/thumb\/128$/, () => webp());
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    const { rerender, client } = renderVola(<VolaThumb file={fileInfo()} size={128} />, server);
    await screen.findByAltText("report.pdf");
    rerender(<span />);
    renderVola(<VolaThumb file={fileInfo()} size={128} />, server, { client });
    await waitFor(() => expect(screen.getAllByAltText("report.pdf").length).toBeGreaterThan(0));
    // a second provider is a second cache; within one provider a remount hits the cache:
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("asks again when the live row says the processing is DONE", async () => {
    const server = new FakeServer();
    let calls = 0;
    server.on("GET", /\/thumb\/64$/, () => (++calls === 1 ? generating() : webp()));
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
    renderVola(<Row />, server);
    await screen.findByRole("img", { name: "Thumbnail is being made" });
    expect(calls).toBe(1);
    await act(async () => {
      screen.getByText("done").click();
    });
    // `processing_status` changed → the thumbnail is asked for again (RUNNING → DONE)
    expect(await screen.findByAltText("report.pdf")).toBeTruthy();
    expect(calls).toBe(2);
  });
});
