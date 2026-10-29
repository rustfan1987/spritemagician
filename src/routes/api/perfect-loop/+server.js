/**
 * POST /api/perfect-loop — one call, a set of perfectly looping animations.
 *
 * Body: {
 *   image: dataUrl | /local url | https url,
 *   actions: ['side_walk', { id: 'custom_id', text: 'raises both arms…' }, …],
 *   subject?: '2–4 identifying features',
 *   view?: 'front' | 'side',
 *   reframe?: boolean,          // redraw a front sprite in profile first (view: 'side')
 *   seed?: number, name?: string, folderId?: string, replace?: boolean,
 *   frames?: number, size?: number, pad?: number
 * }
 * Returns: { jobId }. Poll /api/generation-progress?jobId=… — the progress
 * object carries `actions` (per-action status + loop check) and, when
 * status is 'completed', `results` with the saved library files.
 *
 * GET /api/perfect-loop — capability check ({ ffmpeg: boolean }).
 */
import { json } from '@sveltejs/kit';
import { env } from '$lib/server/env.js';
import { approxJsonBytes, enforceRateLimit } from '$lib/server/security.js';
import { isImageInput } from '$lib/server/validation.js';
import { setProgress, setProgressOwner } from '$lib/utils/generationProgress.js';
import { runPerfectLoopJob, ffmpegAvailable } from '$lib/server/perfectLoop.js';

export async function GET({ locals }) {
	if (!locals.user) return json({ error: 'Authentication required' }, { status: 401 });
	return json({ ffmpeg: ffmpegAvailable(), replicate: !!env.REPLICATE_API_TOKEN });
}

export async function POST({ request, locals }) {
	if (!locals.user) return json({ error: 'Authentication required' }, { status: 401 });
	const rate = enforceRateLimit({ uid: locals.user.uid, routeKey: 'perfect-loop', maxRequests: 6, windowMs: 60_000 });
	if (!rate.allowed) return json({ error: 'Rate limit exceeded. Please try again shortly.' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } });
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }
	if (approxJsonBytes(body) > 24 * 1024 * 1024) return json({ error: 'Request payload too large' }, { status: 413 });
	if (!isImageInput(body?.image)) return json({ error: 'image must be a data URL or URL' }, { status: 400 });
	const actions = Array.isArray(body.actions) ? body.actions.slice(0, 12) : [];
	if (!actions.length) return json({ error: 'Pick at least one action' }, { status: 400 });
	if (!env.REPLICATE_API_TOKEN) return json({ error: 'Replicate is not configured. Add your REPLICATE_API_TOKEN in Settings.', code: 'MISSING_KEY', key: 'REPLICATE_API_TOKEN' }, { status: 412 });
	if (!ffmpegAvailable()) return json({ error: 'ffmpeg was not found. Install it from https://ffmpeg.org and make sure it is on PATH (or set FFMPEG_PATH).', code: 'MISSING_FFMPEG' }, { status: 412 });

	const jobId = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	setProgressOwner(jobId, locals.user.uid);
	setProgress(jobId, { status: 'starting', message: 'Queued…', actions: [], results: [], currentFrame: 0, totalFrames: actions.length });
	runPerfectLoopJob({
		jobId, uid: locals.user.uid,
		image: body.image, actions,
		subject: body.subject, view: body.view, reframe: !!body.reframe,
		seed: body.seed, name: body.name, folderId: body.folderId || null, replace: !!body.replace,
		frames: body.frames, size: body.size, pad: body.pad
	});
	return json({ jobId, actions: actions.length });
}
