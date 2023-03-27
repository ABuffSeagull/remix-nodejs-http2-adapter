/// <reference types="@total-typescript/ts-reset" />
import * as http2 from "node:http2";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	Request,
	createRequestHandler,
	createReadableStreamFromReadable,
	writeReadableStreamToWritable,
} from "@remix-run/node";
import { lookup } from "mrmime";
import { text } from "stream/consumers";

/**
 * @param {Object} options
 * @param {import('@remix-run/node').ServerBuild} options.build
 */
export default async function buildStreamHandler({ build }) {
	/** @type {Map<string, string>} */
	const staticMap = new Map();

	const publicPath = path.resolve(path.dirname(build.assetsBuildDirectory));
	await buildStaticFiles(publicPath, staticMap, publicPath);

	const handler = createRequestHandler(build);

	/**
	 * @this {http2.Http2Server}
	 * @param {http2.ServerHttp2Stream} stream
	 * @param {http2.IncomingHttpHeaders} headers
	 */
	return async function onStream(stream, headers) {
		const {
			":scheme": scheme,
			":authority": authority,
			":path": requestPath,
			":method": method,
			...otherRequestHeaders
		} = headers;

		if (requestPath && staticMap.has(requestPath)) {
			const cacheValue = requestPath.startsWith(build.publicPath)
				? `max-age=${60 * 60 * 24 * 365}, immutable`
				: `max-age=${60 * 60 * 6}`;

			let fullPath = /** @type {string} */ (
				staticMap.get(`${requestPath}.br`) ?? staticMap.get(`${requestPath}.gz`) ?? staticMap.get(requestPath)
			);

			const contentType = lookup(requestPath) ?? "application/octet-stream";

			let encoding = "identity";
			if (fullPath.endsWith(".br")) {
				encoding = "br";
			} else if (fullPath.endsWith(".gz")) {
				encoding = "gzip";
			}

			stream.respondWithFile(fullPath, {
				"cache-control": `public, ${cacheValue}`,
				"content-type": contentType,
				"content-encoding": encoding,
			});
			return;
		}

		const controller = new AbortController();
		stream.once("aborted", () => controller.abort());

		const response = await handler(
			new Request(`${scheme}://${authority}${requestPath}`, {
				method: method,
				// TODO: replace with Readable.toWeb when stable
				body: method == "GET" || method == "HEAD" ? null : createReadableStreamFromReadable(stream),
				headers: otherRequestHeaders,
				signal: controller.signal,
			}),
		);

		let encoding = "identity";
		if (headers["accept-encoding"]?.includes("br")) {
			encoding = "br";
		} else if (headers["accept-encoding"]?.includes("gzip")) {
			encoding = "gzip";
		} else if (headers["accept-encoding"]?.includes("deflate")) {
			encoding = "deflate";
		}
		stream.respond({
			...Object.fromEntries(response.headers),
			":status": response.status,
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
			compression.pipe(stream);
			writeReadableStreamToWritable(response.body, compression);
		} else {
			stream.end();
		}
	};
}

/**
 * @param {string} publicPath
 * @param {Map<string, string>} staticMap
 * @param {string} pathname
 */
async function buildStaticFiles(publicPath, staticMap, pathname) {
	const dir = await fs.opendir(pathname);

	const subdirs = [];
	for await (const entry of dir) {
		if (entry.isDirectory()) {
			subdirs.push(entry.name);
		} else if (entry.isFile()) {
			const relativePath = path.relative(publicPath, path.resolve(dir.path, entry.name));
			staticMap.set(`/${relativePath}`, path.resolve(dir.path, entry.name));
		}
	}

	await Promise.all(subdirs.map((name) => buildStaticFiles(publicPath, staticMap, path.resolve(pathname, name))));
}
