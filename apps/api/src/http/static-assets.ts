import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sendError, type RouteHandler } from "./http-kit.ts";

const webRoot = join(process.cwd(), "apps/web/public");

// An explicit allow-list keeps arbitrary paths (including traversal attempts) off the file system.
const assets: ReadonlySet<string> = new Set([
  "index.html",
  "incident.html",
  "services.html",
  "service.html",
  "incidents.html",
  "styles.css",
  "app.js",
  "incident.js",
  "services.js",
  "service.js",
  "incidents.js",
  "topology.js",
  "investigation-view.js",
  "scenario-controls.js",
  "incident-metrics.js",
]);

export const serveStaticAsset: RouteHandler = async (context) => {
  const asset = context.url.pathname === "/" ? "index.html" : context.url.pathname.slice(1);
  if (!assets.has(asset)) {
    sendError(context, 404, "Route not found");
    return;
  }
  try {
    const body = await readFile(join(webRoot, asset));
    const contentType = asset.endsWith(".css") ? "text/css" : asset.endsWith(".js") ? "application/javascript" : "text/html";
    context.response.writeHead(200, { "content-type": `${contentType}; charset=utf-8` });
    context.response.end(body);
  } catch {
    sendError(context, 404, "Asset not found");
  }
};
