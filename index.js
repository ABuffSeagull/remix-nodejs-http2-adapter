import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import process from "node:process";

import {
  createReadableStreamFromReadable,
  createRequestHandler,
  writeReadableStreamToWritable,
} from "@remix-run/node";

/**
 * @param {Object} props
 * @param {import("@remix-run/node").ServerBuild} props.build
 * @param {(req: import('node:http2').Http2ServerResponse) => Promise<boolean>} props.staticHandler
 * @param {typeof process.env.NODE_ENV} [props.mode=process.env.NODE_ENV]
 */
export function buildRequestHandler({
  build,
  staticHandler,
  mode = process.env.NODE_ENV,
}) {
  const handler = createRequestHandler(build, mode);

  /**
   * @this {import("http2").Http2Server}
   * @param {import("http2").Http2ServerRequest} serverRequest
   * @param {import("http2").Http2ServerResponse} serverResponse
   */
  return async function onRequest(serverRequest, serverResponse) {
    const start = performance.now();

    if (await staticHandler(serverResponse)) return;

    const {
      ":scheme": scheme,
      ":authority": authority,
      ":path": requestPath,
      ":method": method,
      ...otherRequestHeaders
    } = serverRequest.headers;
    const controller = new AbortController();
    serverRequest.once("aborted", () => controller.abort());

    const headers = new Headers();
    for (const [key, value] of Object.entries(otherRequestHeaders)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          headers.append(key, v);
        }
      } else if (value) {
        headers.append(key, value);
      }
    }

    const request = new Request(
      `${scheme}://${authority ?? otherRequestHeaders.host}${requestPath}`,
      {
        method,
        // TODO: replace with Readable.toWeb when stable
        body:
          method == "GET" || method == "HEAD"
            ? null
            : createReadableStreamFromReadable(serverRequest),
        duplex: "half",
        headers,
        signal: controller.signal,
      },
    );

    const response = await handler(request);

    let encoding = "identity";
    const accept = serverRequest.headers["accept-encoding"] ?? "";
    if (accept.includes("br")) {
      encoding = "br";
    } else if (accept.includes("gzip")) {
      encoding = "gzip";
    } else if (accept.includes("deflate")) {
      encoding = "deflate";
    }
    serverResponse.writeHead(response.status, {
      "cache-control": "no-cache",
      "content-encoding": encoding,
      ...Object.fromEntries(response.headers),
    });
    if (response.body) {
      let compression = null;
      switch (encoding) {
        case "br": {
          compression = zlib.createBrotliCompress({
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
          });
          break;
        }
        case "gzip": {
          compression = zlib.createGzip();
          break;
        }
        case "deflate": {
          compression = zlib.createDeflate();
          break;
        }
        default: {
          compression = new PassThrough();
          break;
        }
      }
      compression.pipe(serverResponse);
      await writeReadableStreamToWritable(response.body, compression);
    } else {
      serverResponse.end();
    }
    if (this.listenerCount("response") > 0) {
      const duration = performance.now() - start;
      this.emit("response", {
        duration,
        request: new Request(`${scheme}://${authority}${requestPath}`, {
          method: method,
          headers,
        }),
        response: new Response(null, response),
      });
    }
  };
}

/**
 * @param {import("@remix-run/node").ServerBuild} build
 */
export async function buildDefaultStaticHandler(build) {
  const staticMap = /** @type Map<string, string> */ (new Map());

  const publicPath = path.resolve(path.dirname(build.assetsBuildDirectory));
  await buildStaticFiles(publicPath, staticMap, publicPath);

  const { default: db } = await import("mime-db");
  const extensionMap = /** @type {Map<string, string>} */ (new Map());
  for (const [mimeType, { extensions = [] }] of Object.entries(db)) {
    for (const ext of extensions) {
      extensionMap.set(ext, mimeType);
    }
  }
  /**
   * @param {import('node:http2').Http2ServerResponse} response
   */
  return async (response) => {
    const { req: request } = response;
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());

    const { ":path": requestPath } = request.headers;

    if (!requestPath || !staticMap.has(requestPath)) return false;
    const cacheValue = requestPath.startsWith(build.publicPath)
      ? `max-age=${60 * 60 * 24 * 365}, immutable`
      : `max-age=${60 * 60 * 6}`;

    const fullPath =
      staticMap.get(`${requestPath}.br`) ??
      staticMap.get(`${requestPath}.gz`) ??
      staticMap.get(requestPath);

    assert.ok(fullPath, `Path ${requestPath} went missing from static map`);

    const contentType =
      extensionMap.get(path.extname(requestPath).slice(1)) ??
      "application/octet-stream";

    let encoding = "identity";
    if (fullPath.endsWith(".br")) {
      encoding = "br";
    } else if (fullPath.endsWith(".gz")) {
      encoding = "gzip";
    }

    try {
      await pipeline(
        fs.createReadStream(fullPath),
        response.writeHead(200, {
          "cache-control": `public, ${cacheValue}`,
          "content-type": contentType,
          "content-encoding": encoding,
        }),
        { signal: controller.signal },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code == "ABORT_ERR"
      ) {
        return;
      }
      throw error;
    }

    return true;
  };
}

/**
 * @param {string} publicPath
 * @param {Map<string, string>} staticMap
 * @param {string} pathname
 */
async function buildStaticFiles(publicPath, staticMap, pathname) {
  const dir = await fsp.opendir(pathname);

  const subdirs = [];
  for await (const entry of dir) {
    if (entry.isDirectory()) {
      subdirs.push(entry.name);
    } else if (entry.isFile()) {
      const relativePath = path.relative(
        publicPath,
        path.resolve(dir.path, entry.name),
      );
      staticMap.set(`/${relativePath}`, path.resolve(dir.path, entry.name));
    }
  }

  await Promise.all(
    subdirs.map((name) =>
      buildStaticFiles(publicPath, staticMap, path.resolve(pathname, name)),
    ),
  );
}
