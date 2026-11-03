/*
 * The routes table of the home page's "The API". `doc` is how docs/API.md writes the route;
 * scripts/check-snippets.mjs fails when the document stops naming it.
 */
export const ROUTES = [
  {
    doc: "POST /files/:type/:id",
    route: "POST /files/:type/:id",
    does: "Upload, multipart and streamed",
  },
  { doc: "POST /uploads", route: "POST /uploads", does: "Start a resumable upload (tus 1.0)" },
  {
    doc: "GET` and `HEAD` on `…/:fileId",
    route: "GET /files/:type/:id/:fileId",
    does: "Download, with Range, HEAD and ETag",
  },
  {
    doc: "/thumb/:size",
    route: "GET …/:fileId/thumb/:size",
    does: "A WebP thumbnail; 202 while it renders",
  },
  {
    doc: "GET …/:fileId/info?ocr=full",
    route: "GET …/:fileId/info?ocr=full",
    does: "The text the worker read",
  },
  {
    doc: "GET /folders/:type/:id[/*path]",
    route: "GET /folders/:type/:id[/*path]",
    does: "One level of a folder",
  },
  {
    doc: "POST /shares",
    route: "POST /shares",
    does: "A share link: password, expiry, download cap",
  },
  { doc: "GET\\|HEAD /s/:token", route: "GET /s/:token", does: "Open a share, no key" },
  {
    doc: "POST /udc/list",
    route: "POST /udc/list",
    does: "Filter, sort and page the files collection",
  },
  { doc: "GET /udc/subscribe", route: "GET /udc/subscribe", does: "Live rows over a WebSocket" },
  { doc: "/keyrings/me/", route: "POST /keyrings/me/unlock", does: "Open a PIN-protected keyring" },
];
