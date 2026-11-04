/* The highlighting of a file of the tutorial, by its name. */
const BY_EXTENSION = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".json": "json",
  ".yaml": "yaml",
  ".sh": "sh",
  ".sql": "sql",
  ".css": "css",
  ".html": "html",
  ".hbs": "handlebars",
  ".example": "ini",
};

export function langOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Makefile") return "make";
  if (name === "Dockerfile") return "docker";
  return BY_EXTENSION[name.slice(name.lastIndexOf("."))] ?? "txt";
}
