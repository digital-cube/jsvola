import { Command } from "commander";

export const CLI_VERSION = "1.0.0";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * The `vola` command tree. Subcommands (tenants, keys, migrations) arrive with the auth
 * ticket (plan 1.2); for now the program knows its name, version and help.
 */
export function buildProgram(io: CliIo): Command {
  const program = new Command("vola")
    .description("JSVola — self-hosted, multi-tenant content-addressable file storage")
    .version(CLI_VERSION, "-V, --version", "print the version")
    .configureOutput({
      writeOut: (text) => io.out(text.replace(/\n$/, "")),
      writeErr: (text) => io.err(text.replace(/\n$/, "")),
    })
    .exitOverride()
    .showHelpAfterError();
  return program;
}

/**
 * Parses `argv` (without `node` and the script) and returns the process exit code.
 * `program` defaults to `buildProgram(io)`; tests pass one with extra commands.
 */
export async function runCli(
  argv: string[],
  io: CliIo,
  program = buildProgram(io),
): Promise<number> {
  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    // commander's exitOverride throws for --help/--version (code 0) and usage errors.
    if (error && typeof error === "object" && "exitCode" in error) {
      return Number((error as { exitCode: number }).exitCode);
    }
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
