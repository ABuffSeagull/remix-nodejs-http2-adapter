import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
	Request,
	Response,
	createReadableStreamFromReadable,
	createRequestHandler,
	writeReadableStreamToWritable,
} from "@remix-run/node";
import db from "mime-db";

const extensionMap = /** @type {Map<string, string>} */ (new Map());
for (const [mimeType, { extensions = [] }] of Object.entries(db)) {
	for (const ext of extensions) {
		extensionMap.set(ext, mimeType);
	}
}

/**
 * @param {Object} props
 * @param {import("@remix-run/node").ServerBuild} props.build
 */
export default async function buildRequestHandler({ build }) {
	const staticMap = /** @type Map<string, string> */ (new Map());

	const publicPath = path.resolve(path.dirname(build.assetsBuildDirectory));
	await buildStaticFiles(publicPath, staticMap, publicPath);

	const handler = createRequestHandler(build);

	/**
	 * @this {import("http2").Http2Server}
	 * @param {import("http2").Http2ServerRequest} serverRequest
	 * @param {import("http2").Http2ServerResponse} serverResponse
	 */
	return async function onRequest(serverRequest, serverResponse) {
		const start = performance.now();
		const {
			":scheme": scheme,
			":authority": authority,
			":path": requestPath,
			":method": method,
			...otherRequestHeaders
		} = serverRequest.headers;

		if (requestPath && staticMap.has(requestPath)) {
			const cacheValue = requestPath.startsWith(build.publicPath)
				? `max-age=${60 * 60 * 24 * 365}, immutable`
				: `max-age=${60 * 60 * 6}`;

			const fullPath =
				staticMap.get(`${requestPath}.br`) ??
				staticMap.get(`${requestPath}.gz`) ??
				staticMap.get(requestPath);

			assert.ok(fullPath, `Path ${requestPath} went missing from static map`);

			const contentType =
				extensionMap.get(path.extname(requestPath)) ??
				"application/octet-stream";

			let encoding = "identity";
			if (fullPath.endsWith(".br")) {
				encoding = "br";
			} else if (fullPath.endsWith(".gz")) {
				encoding = "gzip";
			}

			await pipeline(
				fs.createReadStream(fullPath),
				serverResponse.writeHead(200, {
					"cache-control": `public, ${cacheValue}`,
					"content-type": contentType,
					"content-encoding": encoding,
				}),
			);

			return;
		}

		const controller = new AbortController();
		serverResponse.once("close", () => controller.abort());

		const request = new Request(`${scheme}://${authority}${requestPath}`, {
			method: method,
			// TODO: replace with Readable.toWeb when stable
			body:
				method == "GET" || method == "HEAD"
					? null
					: createReadableStreamFromReadable(serverRequest),
			headers: otherRequestHeaders,
			signal: controller.signal,
		});

		const response = await handler(request);

		let encoding = "identity";
		if (serverRequest.headers["accept-encoding"]?.includes("br")) {
			encoding = "br";
		} else if (serverRequest.headers["accept-encoding"]?.includes("gzip")) {
			encoding = "gzip";
		} else if (serverRequest.headers["accept-encoding"]?.includes("deflate")) {
			encoding = "deflate";
		}
		serverResponse.writeHead(response.status, {
			...Object.fromEntries(response.headers),
			"content-encoding": encoding,
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
			writeReadableStreamToWritable(response.body, compression);
		} else {
			serverResponse.end();
		}
		const duration = performance.now() - start;
		this.emit("respond", {
			duration,
			request: new Request(request, { body: null }),
			response: new Response(null, response),
		});

		await once(serverResponse, "finish");
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
