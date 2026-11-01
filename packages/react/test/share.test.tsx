import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { localToIso, VolaShareDialog } from "../src/index.js";
import { FakeServer, fileInfo, json, keyringStatus, renderVola } from "./fake.js";

const shareInfo = (encrypted: boolean) => ({
  id: "019a0000-0000-7000-8000-00000000s001",
  tenant_id: fileInfo().tenant_id,
  file_id: fileInfo().id,
  folder_id: null,
  scope: "PUBLIC_LINK",
  has_password: true,
  expires_at: null,
  max_downloads: 5,
  download_count: 0,
  created_by: "user-1",
  created_at: "2026-11-01T10:00:00.000Z",
  revoked_at: null,
  encrypted,
});

function shareServer(encrypted: boolean) {
  const server = new FakeServer();
  const shares: ReturnType<typeof shareInfo>[] = [];
  server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: false })));
  server.on("GET", "/vola/shares", () => json({ shares }));
  server.on("POST", "/vola/shares", ({ body }) => {
    const share = shareInfo(encrypted);
    shares.push(share);
    expect(body).toMatchObject({ file_id: fileInfo().id, password: "pw", max_downloads: 5 });
    return json(
      {
        ...share,
        token: "t".repeat(43),
        url: `http://vola.test/vola/s/${"t".repeat(43)}${encrypted ? "#secretsecret" : ""}`,
      },
      201,
    );
  });
  server.on("DELETE", /^\/vola\/shares\//, () => {
    const share = shares.pop();
    return json({ ...share, revoked_at: "2026-11-01T11:00:00.000Z" });
  });
  return server;
}

describe("VolaShareDialog", () => {
  it("warns about an encrypted file, makes the link with its fragment, copies it, lists and revokes", async () => {
    const server = shareServer(true);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onClose = vi.fn();
    renderVola(
      <VolaShareDialog file={fileInfo({ encryption: "keyring" })} open onClose={onClose} />,
      server,
    );
    const dialog = await screen.findByRole("dialog", { name: "Share “report.pdf”" });
    expect(within(dialog).getByRole("note").textContent).toMatch(
      /encrypted.*plain content.*after #/s,
    );
    expect(await within(dialog).findByText("No links yet.")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText("Password (optional)"), "pw");
    await userEvent.type(within(dialog).getByLabelText("Most downloads (optional)"), "5");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    const link = (await within(dialog).findByLabelText("Link")) as HTMLInputElement;
    expect(link.value).toBe(`http://vola.test/vola/s/${"t".repeat(43)}#secretsecret`);
    await userEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(link.value);
    expect(await within(dialog).findByText("Copied")).toBeTruthy();
    // listed, with its facts; then revoked
    expect(await within(dialog).findByText("0 downloads of 5")).toBeTruthy();
    expect(within(dialog).getByText("password")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: /^Revoke/ }));
    await waitFor(() => expect(server.of("DELETE", "/vola/shares/").length).toBe(1));
    expect(await within(dialog).findByText("No links yet.")).toBeTruthy();
    // the password went in the body, never the URL
    expect(server.calls.every((c) => !c.path.includes("pw"))).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows no warning for a plain file", async () => {
    const server = shareServer(false);
    renderVola(<VolaShareDialog file={fileInfo()} open onClose={() => undefined} />, server);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("note")).toBeNull();
  });

  it("localToIso", () => {
    expect(localToIso("")).toBeUndefined();
    expect(localToIso("nonsense")).toBeUndefined();
    expect(localToIso("2026-12-31T10:00")).toMatch(/^2026-12-31T\d\d:00:00\.000Z$/);
  });
});
