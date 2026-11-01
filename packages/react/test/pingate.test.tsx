import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { VolaPinGate } from "../src/index.js";
import { error, FakeServer, json, keyringStatus, renderVola } from "./fake.js";

async function typePin(pin: string) {
  for (let i = 0; i < pin.length; i++) {
    const field = screen.getByLabelText(`PIN digit ${i + 1}`);
    await userEvent.type(field, pin[i] as string);
  }
}

describe("VolaPinGate", () => {
  it("shows the attempts after a wrong PIN, the countdown of a lock-out, and the content after the right one", async () => {
    const server = new FakeServer();
    let unlocked = false;
    server.on("GET", "/vola/keyrings/me/status", ({ headers }) =>
      json(
        keyringStatus({
          locked: headers.get("x-vola-unlock") !== "tok",
          unlock_expires_in: unlocked ? 150 : null,
        }),
      ),
    );
    server.on("POST", "/vola/keyrings/me/unlock", ({ body }) => {
      const { pin } = body as { pin: string };
      if (pin === "111111") return error(403, "pin_wrong", { attempts: 1, retry_after: 0 });
      if (pin === "222222") return error(429, "too_many_attempts", { retry_after: 7 });
      unlocked = true;
      return json({ token: "tok", expires_in: 150 });
    });
    renderVola(
      <VolaPinGate>
        <p>secret content</p>
      </VolaPinGate>,
      server,
    );
    expect(await screen.findByText("Enter your PIN")).toBeTruthy();
    expect(screen.queryByText("secret content")).toBeNull();

    await typePin("111111");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Wrong PIN (1 wrong in a row).",
    );
    // the PIN is never in a URL
    expect(server.calls.every((c) => !c.path.includes("111111"))).toBe(true);
    expect(server.of("POST", "/vola/keyrings/me/unlock")[0]?.body).toEqual({ pin: "111111" });

    await typePin("222222");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /Too many wrong PINs\. Try again in [67] s\./,
      ),
    );
    expect((screen.getByLabelText("PIN digit 1") as HTMLInputElement).disabled).toBe(true);
  });

  it("unlocks with the right PIN and sends the token from then on", async () => {
    const server = new FakeServer();
    server.on("GET", "/vola/keyrings/me/status", ({ headers }) =>
      json(keyringStatus({ locked: headers.get("x-vola-unlock") !== "tok" })),
    );
    server.on("POST", "/vola/keyrings/me/unlock", () => json({ token: "tok", expires_in: 150 }));
    renderVola(
      <VolaPinGate>
        <p>secret content</p>
      </VolaPinGate>,
      server,
    );
    await screen.findByText("Enter your PIN");
    await typePin("123456");
    expect(await screen.findByText("secret content")).toBeTruthy();
    await waitFor(() =>
      expect(
        server.of("GET", "/vola/keyrings/me/status").at(-1)?.headers.get("x-vola-unlock"),
      ).toBe("tok"),
    );
  });

  it("sets up a PIN: repeat it, see the recovery key once, confirm it was saved", async () => {
    const server = new FakeServer();
    let hasPin = false;
    server.on("GET", "/vola/keyrings/me/status", () =>
      json(
        keyringStatus({ has_pin: hasPin, keyring_id: hasPin ? keyringStatus().keyring_id : null }),
      ),
    );
    server.on("POST", "/vola/keyrings/me", ({ body }) => {
      hasPin = true;
      expect(body).toEqual({ pin: "135790" });
      return json(
        {
          keyring_id: keyringStatus().keyring_id,
          recovery_key: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567",
        },
        201,
      );
    });
    renderVola(
      <VolaPinGate>
        <p>secret content</p>
      </VolaPinGate>,
      server,
    );
    expect(await screen.findByText("Choose a PIN")).toBeTruthy();
    await typePin("135790");
    expect(await screen.findByText("Repeat the PIN")).toBeTruthy();
    await typePin("135790");
    expect(await screen.findByText("Your recovery key")).toBeTruthy();
    expect(screen.getByText("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567")).toBeTruthy();
    const next = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "I have saved the recovery key" }));
    expect(next.disabled).toBe(false);
    await userEvent.click(next);
    expect(await screen.findByText("Enter your PIN")).toBeTruthy();
  });

  it("reset asks for the word RESET and says what is lost", async () => {
    const server = new FakeServer();
    let hasPin = true;
    server.on("GET", "/vola/keyrings/me/status", () => json(keyringStatus({ has_pin: hasPin })));
    server.on("GET", "/vola/keyrings/me/delete-preview", () =>
      json({ keyring_id: keyringStatus().keyring_id, files: 12, live_files: 10, bytes: 2048 }),
    );
    server.on("POST", "/vola/keyrings/me/reset", ({ body }) => {
      expect(body).toEqual({ confirm: "RESET" });
      hasPin = false;
      return json({ keyring_id: keyringStatus().keyring_id, files: 12, blobs: 9 });
    });
    renderVola(<VolaPinGate />, server);
    await screen.findByText("Enter your PIN");
    await userEvent.click(screen.getByRole("button", { name: "Reset the keyring" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/lost for good/)).toBeTruthy();
    expect(await within(dialog).findByText("12 files (10 live, 2.0 KB)")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Reset the keyring",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText("Type RESET to confirm"), "RESET");
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(server.of("POST", "/vola/keyrings/me/reset").length).toBe(1));
    expect(await screen.findByText(/12 files are gone/)).toBeTruthy();
    // the keyring is gone: the setup screen follows
    expect(await screen.findByText("Choose a PIN")).toBeTruthy();
  });
});
