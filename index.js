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
			const fullPath = /** @type {string} */ (staticMap.get(requestPath));
			const cacheValue = requestPath.startsWith(build.publicPath)
				? `max-age=${60 * 60 * 24 * 365}, immutable`
				: `max-age=${60 * 60 * 6}`;
			stream.respondWithFile(fullPath, {
				"cache-control": `public, ${cacheValue}`,
				"content-type": lookup(fullPath) ?? "application/octet-stream",
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

		stream.respond({
			...Object.fromEntries(response.headers),
			":status": response.status,
		});
		if (response.body) {
			// TODO: replace with Readable.fromWeb when stable
			await writeReadableStreamToWritable(response.body, stream);
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
