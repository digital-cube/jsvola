import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { formatBytes, VolaKeyringStatus, VolaPinGate } from "../src/index.js";
import { error, FakeServer, json, keyringStatus, renderVola } from "./fake.js";

async function typePin(pin: string, label = "PIN") {
  const group = screen.getByRole("group", { name: label });
  for (let i = 0; i < pin.length; i++) {
    await userEvent.type(within(group).getByLabelText(`PIN digit ${i + 1}`), pin[i] as string);
  }
}

describe("VolaPinGate flows", () => {
  it("recovers with the recovery key and shows the NEW one once", async () => {
    const server = new FakeServer();
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus()));
    server.on("POST", "/vola/keyrings/me/recover", ({ body }) => {
      if ((body as { recovery_key: string }).recovery_key !== "GOOD-KEY")
        return error(403, "recovery_wrong");
      expect(body).toEqual({ recovery_key: "GOOD-KEY", new_pin: "246810" });
      return json({ keyring_id: keyringStatus().keyring_id, recovery_key: "NEWK-NEWK" });
    });
    renderVola(<VolaPinGate />, server);
    await screen.findByText("Enter your PIN");
    await userEvent.click(screen.getByRole("button", { name: "Forgot your PIN?" }));
    expect(screen.getByText("Recover with the recovery key")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Recovery key"), "BAD");
    await typePin("246810", "New PIN");
    await userEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "That recovery key is not right.",
    );
    await userEvent.clear(screen.getByLabelText("Recovery key"));
    await userEvent.type(screen.getByLabelText("Recovery key"), "GOOD-KEY");
    await userEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect(await screen.findByText("Your NEW recovery key")).toBeTruthy();
    expect(screen.getByText("NEWK-NEWK")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Enter your PIN")).toBeTruthy();
    // Back from the recover screen
    await userEvent.click(screen.getByRole("button", { name: "Forgot your PIN?" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Enter your PIN")).toBeTruthy();
  });

  it("setup refuses a mismatch and relays a trivial PIN; a status error offers a retry; allowSetup=false", async () => {
    const server = new FakeServer();
    let statusCalls = 0;
    server.on("GET", "/vola/keyrings/me/status", () =>
      ++statusCalls === 1
        ? error(500, "boom")
        : json(keyringStatus({ has_pin: false, keyring_id: null })),
    );
    server.on("POST", "/vola/keyrings/me", () => error(422, "pin_invalid", { reason: "trivial" }));
    renderVola(<VolaPinGate />, server);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Something went wrong: boom",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Choose a PIN")).toBeTruthy();
    await typePin("123456");
    await screen.findByText("Repeat the PIN");
    await typePin("654321");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The PINs differ. Start over.",
    );
    expect(screen.getByText("Choose a PIN")).toBeTruthy();
    await typePin("123456");
    await screen.findByText("Repeat the PIN");
    await typePin("123456");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/too easy/));
    const { unmount } = renderVola(<VolaPinGate allowSetup={false} />, server);
    void unmount;
    expect(await screen.findAllByText("Locked")).toBeTruthy();
  });

  it("changes the PIN from the status line; every token dies, so the page locks", async () => {
    const server = new FakeServer();
    server.on("GET", "/vola/keyrings/me/status", ({ headers }) =>
      json(keyringStatus({ locked: headers.get("x-vola-unlock") !== "tok" })),
    );
    let changed = 0;
    server.on("PUT", "/vola/keyrings/me/pin", ({ body }) => {
      changed += 1;
      if (changed === 1) return error(403, "pin_wrong", { attempts: 1, retry_after: 1 });
      expect(body).toEqual({ current_pin: "111111", new_pin: "222222" });
      return new Response(null, { status: 204 });
    });
    renderVola(
      <VolaPinGate>
        <VolaKeyringStatus />
        <p>secret content</p>
      </VolaPinGate>,
      server,
      { clientOptions: { unlock: "tok" } },
    );
    await screen.findByText("secret content");
    await userEvent.click(screen.getByRole("button", { name: "Change PIN" }));
    const dialog = screen.getByRole("dialog", { name: "Change PIN" });
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await typePin("111111", "Current PIN");
    await typePin("222222", "New PIN");
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "Wrong PIN (1 wrong in a row). Next try in 1 s.",
    );
    await userEvent.click(save);
    await waitFor(() => expect(screen.queryByText("secret content")).toBeNull());
    expect(screen.getByText("Enter your PIN")).toBeTruthy();
  });

  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
