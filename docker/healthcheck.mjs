#!/usr/bin/env node
// Container health check: exits 0 when GET <prefix>/health/ready answers 200 (the server is up
// and reaches PostgreSQL, and Redis when configured). Installed in the image as `vola-healthcheck`.
const port = process.env.VOLA_PORT || "8300";
const prefix = (process.env.VOLA_PREFIX || "/vola").replace(/\/+$/, "");
try {
  const response = await fetch(`http://127.0.0.1:${port}${prefix}/health/ready`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
