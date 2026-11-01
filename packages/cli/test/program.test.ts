import { describe, expect, it } from "vitest";
import { buildProgram, CLI_VERSION, runCli } from "../src/index.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("vola CLI", () => {
  it("prints help without arguments", async () => {
    const c = capture();
    expect(await runCli([], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("Usage: vola");
  });

  it("prints its version", async () => {
    const c = capture();
    expect(await runCli(["--version"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain(CLI_VERSION);
  });

  it("fails on an unknown option", async () => {
    const c = capture();
    expect(await runCli(["--nope"], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("unknown option");
  });

  it("reports a failing command as exit code 1 with its message", async () => {
    const c = capture();
    const program = buildProgram(c.io);
    program.command("explode").action(() => {
      throw new Error("kaboom");
    });
    program.command("reject").action(() => Promise.reject("plain string"));
    expect(await runCli(["explode"], c.io, program)).toBe(1);
    expect(c.err).toContain("kaboom");
    expect(await runCli(["reject"], c.io, program)).toBe(1);
    expect(c.err).toContain("plain string");
  });
});
