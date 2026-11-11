// SPDX-License-Identifier: Apache-2.0

// Like `proxyToBackend`, but relays the backend's answer as a stream instead of
// reading it into memory first. For large file downloads (saved-analysis
// exports, docs/saved-analyses.md §15), where buffering a few hundred
// megabytes per request in the gateway is what this avoids.
//
// Import it as a namespace (`import * as streaming from …`) and call
// `streaming.proxyToBackend(req)`: the OpenAPI generator recognises a proxied
// route by a call ending in `proxyToBackend` and merges the backend's schema.

import { PROXY_CACHE_CONTROL } from '@/auth/proxy-backend';
import { buildInternalIdentityHeaders } from '@/lib/internalIdentity';

const PYTHON_API_URL = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:3001';

/** Response headers worth passing through for a file. */
const RELAYED_HEADERS = [
	'content-type',
	'content-length',
	'content-disposition',
	'etag',
	'last-modified',
	'x-export-sha256',
];

export async function proxyToBackend(
	req: Request,
	{ userId }: { userId?: string } = {},
): Promise<Response> {
	const incoming = new URL(req.url);
	const target = `${PYTHON_API_URL}${incoming.pathname}${incoming.search}`;

	const headers: Record<string, string> = {};
	if (userId) Object.assign(headers, buildInternalIdentityHeaders(userId));

	const upstream = await fetch(target, { method: 'GET', headers });

	const relayed = new Headers({ 'Cache-Control': PROXY_CACHE_CONTROL });
	for (const name of RELAYED_HEADERS) {
		const value = upstream.headers.get(name);
		if (value) relayed.set(name, value);
	}
	if (!relayed.has('content-type')) relayed.set('content-type', 'application/json');
	return new Response(upstream.body, { status: upstream.status, headers: relayed });
}
