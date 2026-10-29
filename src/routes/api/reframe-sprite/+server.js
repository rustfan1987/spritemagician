/**
 * POST /api/reframe-sprite
 *
 * Re-pose / re-view a sprite with an image-editing model while keeping the
 * character's identity. Used to build side-scroller (profile) versions of a
 * front-facing sprite before animating it, and usable for "back view",
 * "three-quarter view", "holding a sword" style edits.
 *
 * Body: { image: dataUrl | /local URL | https URL, view?: 'side'|'side-left'|'back'|'front'|'three-quarter', prompt?: string }
 * Returns: { url: '/local/.uploads/...png', prompt }
 *
 * Runs black-forest-labs/flux-kontext-pro on Replicate (≈$0.04). Only the
 * Replicate key is needed, which is why this exists next to the Gemini/OpenAI
 * based edit-image route.
 */
import { json } from '@sveltejs/kit';
import { runPrediction, toReplicateInput, errorResponse } from '$lib/server/replicate.js';
import { inlineLocalInputs, fetchImageBuffer, saveBuffer } from '$lib/server/localFiles.js';
import { isImageInput } from '$lib/server/validation.js';
import { recordUsageEvent } from '$lib/server/requestTracking.js';

const MODEL = 'black-forest-labs/flux-kontext-pro';

const VIEWS = {
	side: 'Redraw this exact character in a strict full side profile view facing RIGHT, standing upright in a neutral pose, feet on the same ground line, arms relaxed at the sides. Same proportions, colors, clothing, materials and art style. Whole body visible, nothing cropped. Keep the plain flat background exactly as it is.',
	'side-left': 'Redraw this exact character in a strict full side profile view facing LEFT, standing upright in a neutral pose, arms relaxed at the sides. Same proportions, colors, clothing and art style. Whole body visible, nothing cropped. Keep the plain flat background exactly as it is.',
	back: 'Redraw this exact character seen from directly behind, standing upright in a neutral pose. Same proportions, colors, clothing and art style. Whole body visible. Keep the plain flat background exactly as it is.',
	front: 'Redraw this exact character facing the viewer straight on, standing upright in a neutral pose, arms relaxed. Same proportions, colors, clothing and art style. Whole body visible. Keep the plain flat background exactly as it is.',
	'three-quarter': 'Redraw this exact character in a three-quarter view turned slightly to the right, standing in a neutral pose. Same proportions, colors, clothing and art style. Whole body visible. Keep the plain flat background exactly as it is.'
};

export async function POST({ request, locals }) {
	try {
		const body = inlineLocalInputs(await request.json());
		const { image, view = 'side', prompt: customPrompt } = body || {};
		if (!isImageInput(image)) return json({ error: 'image must be a data URL or URL' }, { status: 400 });
		const prompt = String(customPrompt || VIEWS[view] || VIEWS.side).slice(0, 1500);

		const input = {
			prompt,
			input_image: await toReplicateInput(image),
			aspect_ratio: 'match_input_image',
			output_format: 'png',
			safety_tolerance: 2,
			prompt_upsampling: false
		};
		const result = await runPrediction({ model: MODEL, input, maxMs: 180_000 });
		const out = Array.isArray(result.output) ? result.output[0] : result.output;
		if (!out) throw new Error('Image model returned no output');
		const { buffer } = await fetchImageBuffer(out);
		const saved = saveBuffer(buffer, `.uploads/reframe-${view}-${Date.now()}.png`);

		await recordUsageEvent({ uid: locals.user?.uid, routeKey: 'reframe-sprite', provider: 'replicate', statusCode: 200, metadata: { view } });
		return json({ url: saved.url, prompt });
	} catch (error) {
		console.error('[reframe-sprite]', error);
		const { body: errBody, status } = errorResponse(error, 'Reframe failed');
		return json(errBody, { status });
	}
}
