/*
 * The examples site's pages, in the order of menu.yaml. scripts/shots.mjs shoots them and
 * scripts/check-snippets.mjs checks that each has its page under src/content/docs/examples/.
 */
export const EXAMPLES = [
  {
    name: "browse",
    label: "Browse",
    path: "/examples/browse?folder=images",
    shows:
      "Folders, thumbnails and the row menu over the demo files. The list stays live over a WebSocket, so an upload elsewhere appears here.",
  },
  {
    name: "upload",
    label: "Upload",
    path: "/examples/upload",
    shows:
      "One multipart POST under 1 MiB, the resumable protocol above it, with progress, cancel and resume.",
  },
  {
    name: "thumbnails",
    label: "Thumbnails",
    path: "/examples/thumbnails",
    shows:
      "Every size and crop of one file. Regenerate drops the renditions so you can watch 202 become 200.",
  },
  {
    name: "streaming",
    label: "Range & streaming",
    path: "/examples/streaming",
    shows:
      "A video and an audio element playing from vola, and a Range probe showing the 206 the page itself got.",
  },
  {
    name: "share",
    label: "Share",
    path: "/examples/share",
    shows:
      "Make a link with a password, an expiry and a download cap, open it in a new tab, then revoke it.",
  },
  {
    name: "encrypted",
    label: "Encrypted files",
    path: "/examples/encrypted",
    shows:
      "Tenant-encrypted files that read as usual, and a private folder behind a PIN that counts down and locks.",
  },
  {
    name: "api",
    label: "API",
    path: "/examples/api",
    shows: "The routes behind these pages and curl commands with the demo key filled in.",
  },
];
