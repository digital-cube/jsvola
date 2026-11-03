/*
 * The recorded requests and answers of snippets/wire/ (scripts/capture.mjs). A component names a
 * record and gets its text, so nothing about the wire is ever typed into a page; numbers a drawing
 * needs (the Range, the hash) are read back out of the same files.
 */
const files = import.meta.glob<string>("../snippets/wire/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
});

const read = (name: string) => {
  const text = files[`../snippets/wire/${name}.txt`];
  if (text === undefined) throw new Error(`no snippets/wire/${name}.txt; run pnpm run capture`);
  return text.trimEnd();
};

export const wire = (name: string) => ({
  request: read(`${name}.req`),
  answer: read(`${name}.out`),
});

/** `HTTP/1.1 206 Partial Content` → `206 Partial Content`. */
export const statusOf = (name: string) =>
  read(`${name}.out`)
    .split("\n")[0]
    ?.replace(/^HTTP\/\S+ /, "") ?? "";

/** The value of one header of a recorded answer. */
export const headerOf = (name: string, header: string) => {
  const line = read(`${name}.out`)
    .split("\n")
    .find((l) => l.toLowerCase().startsWith(`${header.toLowerCase()}:`));
  if (!line) throw new Error(`snippets/wire/${name}.out.txt has no ${header} header`);
  return line.slice(line.indexOf(":") + 1).trim();
};

/** A string field of a recorded JSON answer. */
export const jsonField = (name: string, field: string) => {
  const match = new RegExp(`"${field}": "([^"]*)"`).exec(read(`${name}.out`));
  if (!match?.[1]) throw new Error(`snippets/wire/${name}.out.txt has no "${field}"`);
  return match[1];
};
