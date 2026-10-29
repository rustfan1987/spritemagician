/**
 * POST /api/text-to-image
 *
 * Plain text → image on Replicate (FLUX schnell, ≈$0.003). Exists so people
 * with only a Replicate key can make a starting sprite; the Gemini/OpenAI
 * based generate-sprite route stays the richer option.
 *
 * Body: { prompt: string, seed?: number, aspectRatio?: '1:1'|'16:9'|'9:16'|'3:2'|'2:3'|'4:5'|'5:4'|'3:4'|'4:3' }
 * Returns: { url: '/local/.uploads/...png', seed }
 */
import { json } from '@sveltejs/kit';
import { runPrediction, errorResponse } from '$lib/server/replicate.js';
import { fetchImageBuffer, saveBuffer } from '$lib/server/localFiles.js';
import { recordUsageEvent } from '$lib/server/requestTracking.js';

const MODEL = 'black-forest-labs/flux-schnell';
const RATIOS = new Set(['1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3']);

export async function POST({ request, locals }) {
	try {
		const { prompt, seed, aspectRatio } = (await request.json()) || {};
		const text = String(prompt || '').trim().slice(0, 2000);
		if (!text) return json({ error: 'prompt is required' }, { status: 400 });
		const safeSeed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : Math.floor(Math.random() * 2_147_483_647);

		const input = {
			prompt: text,
			seed: safeSeed,
			aspect_ratio: RATIOS.has(aspectRatio) ? aspectRatio : '1:1',
			megapixels: '1',
			num_outputs: 1,
			output_format: 'png',
			output_quality: 100,
			num_inference_steps: 4,
			go_fast: true
		};
		const result = await runPrediction({ model: MODEL, input, maxMs: 120_000 });
		const out = Array.isArray(result.output) ? result.output[0] : result.output;
		if (!out) throw new Error('Image model returned no output');
		const { buffer } = await fetchImageBuffer(out);
		const saved = saveBuffer(buffer, `.uploads/t2i-${Date.now()}.png`);
		await recordUsageEvent({ uid: locals.user?.uid, routeKey: 'text-to-image', provider: 'replicate', statusCode: 200 });
		return json({ url: saved.url, seed: safeSeed });
	} catch (error) {
		console.error('[text-to-image]', error);
		const { body, status } = errorResponse(error, 'Image generation failed');
		return json(body, { status });
	}
}
