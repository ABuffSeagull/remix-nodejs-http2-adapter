import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { constants } from "node:http2";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

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
      [constants.HTTP2_HEADER_SCHEME]: _scheme,
      [constants.HTTP2_HEADER_AUTHORITY]: _authority,
      [constants.HTTP2_HEADER_PATH]: _requestPath,
      [constants.HTTP2_HEADER_METHOD]: _method,
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
      `${serverRequest.scheme}://${serverRequest.authority}${serverRequest.url}`,
      {
        method: serverRequest.method,
        // TODO: replace with Readable.toWeb when stable
        body:
          serverRequest.method == "GET" || serverRequest.method == "HEAD"
            ? null
            : createReadableStreamFromReadable(serverRequest),
        duplex: "half",
        headers,
        signal: controller.signal,
      },
    );

    const response = await handler(request);

    const [encodingResult] = parseEncoding(
      /** @type {string | undefined} */ (
        otherRequestHeaders["accept-encoding"]
      ) ?? "*",
    );

    serverResponse.writeHead(response.status, {
      "cache-control": "no-cache",
      "content-encoding": encodingResult?.encoding ?? "identity",
      ...Object.fromEntries(response.headers),
    });
    if (response.body) {
      let compression = null;
      switch (encodingResult?.encoding) {
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
        request: new Request(
          `${serverRequest.scheme}://${serverRequest.authority}${serverRequest.url}`,
          {
            method: serverRequest.method,
            headers,
          },
        ),
        response: new Response(null, response),
      });
    }
  };
}

const preferredEncodingOrder = [
  "*",
  "br",
  "zstd",
  "gzip",
  "deflate",
  "compress",
  "identity",
];
const encodingExtensionMap = new Map([
  ["br", "br"],
  ["zstd", "zst"],
  ["gzip", "gz"],
  ["deflate", "gz"],
  ["compress", "Z"],
]);
/**
 * @param {string} encoding
 */
function parseEncoding(encoding) {
  const encodingRegex =
    /(?<encoding>(\w+|\*))(;q=(?<weight>(0|1)(\.\d{0,3})?))?/gm;

  /** @type {Array<{encoding: string; weight: number}>} */
  let encodings = [];
  for (const match of encoding.matchAll(encodingRegex)) {
    if (match.groups == null || match.groups["encoding"] == null) continue;

    const weight = Number(match.groups["weight"] ?? 0);
    if (weight != 0) {
      encodings.push({
        encoding: match.groups["encoding"],
        weight: Number.isNaN(weight) ? 1 : weight,
      });
    }
  }

  encodings.sort((a, b) =>
    a.weight == b.weight
      ? preferredEncodingOrder.indexOf(a.encoding) -
        preferredEncodingOrder.indexOf(b.encoding)
      : a.weight - b.weight,
  );

  return encodings;
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

    const { pathname } = new URL(
      request.url,
      `${request.scheme}://${request.authority}`,
    );

    if (!staticMap.has(pathname)) return false;

    const cacheValue = pathname.startsWith(build.publicPath)
      ? `max-age=${60 * 60 * 24 * 365}, immutable`
      : `max-age=${60 * 60 * 6}`;

    let encoding = "identity";
    let filePath = staticMap.get(pathname);
    assert.ok(filePath != null, "File has gone missing");
    const acceptEncoding =
      /** @type {Record<string, string>} */ (request.headers)[
        constants.HTTP2_HEADER_ACCEPT_ENCODING
      ] ?? "*";
    for (const requestedEncoding of parseEncoding(acceptEncoding)) {
      const extension = encodingExtensionMap.get(requestedEncoding.encoding);
      if (extension) {
        const foundPath = staticMap.get(`${pathname}.${extension}`);
        if (foundPath) {
          filePath = foundPath;
          encoding = requestedEncoding.encoding;
          break;
        }
      }
    }

    const contentType =
      extensionMap.get(path.extname(pathname).slice(1)) ??
      "application/octet-stream";

    try {
      await pipeline(
        fs.createReadStream(filePath),
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
