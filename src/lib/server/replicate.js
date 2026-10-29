/**
 * Shared Replicate client: one place for auth, input upload, prediction
 * creation and polling with timeouts, 429 backoff and cancellation.
 */
import { env } from './settings.js';
import { isLocalUrl, readLocalUrl, parseDataUrl } from './localFiles.js';

const API = 'https://api.replicate.com/v1';
/** Inputs above this size are uploaded with the Files API instead of inlined. */
const INLINE_LIMIT_BYTES = 256 * 1024;

export class MissingKeyError extends Error {
	constructor(key, provider) {
		super(`${provider} is not configured. Add your ${key} in Settings.`);
		this.name = 'MissingKeyError';
		this.code = 'MISSING_KEY';
		this.key = key;
		this.status = 412;
	}
}

export function requireReplicateToken() {
	const token = env.REPLICATE_API_TOKEN;
	if (!token) throw new MissingKeyError('REPLICATE_API_TOKEN', 'Replicate');
	return token;
}

function authHeaders(extra = {}) {
	return { Authorization: `Bearer ${requireReplicateToken()}`, ...extra };
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				reject(signal.reason || new Error('Aborted'));
			},
			{ once: true }
		);
	});
}

/**
 * Upload a file to Replicate and return a URL the model can read.
 * @param {Buffer} buffer
 * @param {string} mimeType
 */
export async function uploadFile(buffer, mimeType = 'application/octet-stream', filename = 'input') {
	const form = new FormData();
	form.append('content', new Blob([buffer], { type: mimeType }), filename);
	const res = await fetch(`${API}/files`, { method: 'POST', headers: authHeaders(), body: form });
	if (!res.ok) throw new Error(`Replicate file upload failed (${res.status}): ${await res.text()}`);
	const data = await res.json();
	const url = data?.urls?.get;
	if (!url) throw new Error('Replicate file upload returned no URL');
	return url;
}

/**
 * Turn any image/video reference into something Replicate accepts:
 * remote URLs pass through, small files are inlined as data URLs,
 * large files are uploaded through the Files API.
 */
export async function toReplicateInput(ref) {
	if (!ref || typeof ref !== 'string') return ref;
	let buffer;
	let mimeType;
	if (ref.startsWith('data:')) {
		const parsed = parseDataUrl(ref);
		if (!parsed) return ref;
		buffer = Buffer.from(parsed.base64, 'base64');
		mimeType = parsed.mimeType;
		if (buffer.length <= INLINE_LIMIT_BYTES) return ref;
	} else if (isLocalUrl(ref)) {
		const file = readLocalUrl(ref);
		if (!file) throw new Error(`Local file not found: ${ref}`);
		buffer = file.buffer;
		mimeType = file.mimeType;
		if (buffer.length <= INLINE_LIMIT_BYTES) return `data:${mimeType};base64,${buffer.toString('base64')}`;
	} else {
		return ref; // http(s)
	}
	return uploadFile(buffer, mimeType);
}

/**
 * Create a prediction. Pass either `version` (hash) or `model` ("owner/name",
 * always latest version).
 */
export async function createPrediction({ version, model, input, signal, maxAttempts = 6 }) {
	const url = model ? `${API}/models/${model}/predictions` : `${API}/predictions`;
	const body = model ? { input } : { version: String(version).includes(':') ? version.split(':')[1] : version, input };
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(url, {
			method: 'POST',
			headers: authHeaders({ 'Content-Type': 'application/json' }),
			body: JSON.stringify(body),
			signal
		});
		if (res.ok) return res.json();
		const text = await res.text();
		// Accounts with little credit are throttled to one prediction at a time
		// ("burst of 1"). Honour retry_after instead of failing the whole job.
		if (res.status === 429 && attempt < maxAttempts) {
			let wait = Number(res.headers.get('retry-after')) || 0;
			try { wait = Number(JSON.parse(text)?.retry_after) || wait; } catch { /* not json */ }
			const ms = Math.min(30_000, Math.max(2_000, (wait || 5) * 1000 + 500));
			console.warn(`[replicate] 429 on create, retrying in ${ms} ms (attempt ${attempt}/${maxAttempts})`);
			await new Promise((resolve) => setTimeout(resolve, ms));
			if (signal?.aborted) throw new Error('Cancelled');
			continue;
		}
		throw new Error(`Replicate request failed (${res.status}): ${text.slice(0, 500)}`);
	}
}

export async function getPrediction(id, signal) {
	const res = await fetch(`${API}/predictions/${id}`, { headers: authHeaders(), signal });
	if (res.status === 429) {
		const retryAfter = Number(res.headers.get('retry-after')) || 5;
		const err = new Error('Replicate rate limit');
		err.retryAfterMs = retryAfter * 1000;
		throw err;
	}
	if (!res.ok) throw new Error(`Replicate status failed (${res.status})`);
	return res.json();
}

export async function cancelPrediction(id) {
	try {
		await fetch(`${API}/predictions/${id}/cancel`, { method: 'POST', headers: authHeaders() });
	} catch {
		/* best effort */
	}
}

/**
 * Poll until the prediction finishes.
 * @param {object} prediction  initial prediction object
 * @param {{signal?: AbortSignal, maxMs?: number, intervalMs?: number, onTick?: (p: object, elapsedMs: number) => void}} opts
 * @returns {Promise<object>} final prediction (status succeeded)
 */
export async function waitForPrediction(prediction, opts = {}) {
	const { signal, maxMs = 10 * 60 * 1000, intervalMs = 2000, onTick } = opts;
	const startedAt = Date.now();
	let current = prediction;
	let backoff = intervalMs;

	while (current.status === 'starting' || current.status === 'processing' || current.status === 'queued') {
		if (signal?.aborted) {
			await cancelPrediction(current.id);
			throw new Error('Cancelled');
		}
		if (Date.now() - startedAt > maxMs) {
			await cancelPrediction(current.id);
			throw new Error(`Replicate prediction timed out after ${Math.round(maxMs / 1000)}s`);
		}
		await sleep(backoff, signal);
		try {
			current = await getPrediction(current.id, signal);
			backoff = intervalMs;
		} catch (err) {
			if (signal?.aborted) {
				await cancelPrediction(current.id);
				throw new Error('Cancelled');
			}
			backoff = Math.min(err.retryAfterMs || backoff * 2, 30_000);
			console.warn('[replicate] poll error, retrying in', backoff, 'ms:', err.message);
			continue;
		}
		onTick?.(current, Date.now() - startedAt);
	}

	if (current.status === 'succeeded') return current;
	if (current.status === 'canceled') throw new Error('Prediction was cancelled');
	throw new Error(current.error || `Prediction ${current.status || 'failed'}`);
}

/** Create and wait in one call. */
export async function runPrediction({ version, model, input, signal, maxMs, intervalMs, onTick }) {
	const prediction = await createPrediction({ version, model, input, signal });
	return waitForPrediction(prediction, { signal, maxMs, intervalMs, onTick });
}

/** Convert a thrown error to a JSON error body + status. */
export function errorResponse(error, fallback = 'Request failed') {
	const message = error?.message || fallback;
	if (error?.code === 'MISSING_KEY') {
		return { body: { error: message, code: 'MISSING_KEY', key: error.key }, status: 412 };
	}
	return { body: { error: message }, status: 500 };
}
