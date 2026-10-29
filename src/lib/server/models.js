/**
 * Model registry and cost hints.
 *
 * Prices are rough per-run estimates in USD from the providers' public
 * pages (Oct 2026). They exist so the UI can show "≈ $0.05 per clip" and a
 * running total; they are not invoices.
 */
export const MODELS = {
	wan22: { label: 'Wan 2.2 Fast', provider: 'replicate', model: 'wan-video/wan-2.2-i2v-fast', costUsd: 0.05 },
	wan27: { label: 'Wan 2.7 I2V', provider: 'replicate', model: 'wan-video/wan-2.7-i2v', costUsd: 0.4 },
	wan22flf: { label: 'Wan 2.2 First/Last', provider: 'replicate', costUsd: 0.07 },
	svd: { label: 'Stable Video Diffusion', provider: 'replicate', costUsd: 0.2 },
	rembg: { label: 'Background removal', provider: 'replicate', costUsd: 0.002 },
	esrgan: { label: 'Real-ESRGAN upscale', provider: 'replicate', costUsd: 0.003 },
	fluxSchnell: { label: 'FLUX schnell (text to image)', provider: 'replicate', model: 'black-forest-labs/flux-schnell', costUsd: 0.003 },
	fluxKontext: { label: 'FLUX Kontext Pro (re-pose)', provider: 'replicate', model: 'black-forest-labs/flux-kontext-pro', costUsd: 0.04 },
	kling: { label: 'Kling portrait motion', provider: 'replicate', costUsd: 0.5 },
	geminiImage: { label: 'Gemini 2.5 Flash Image', provider: 'gemini', costUsd: 0.04 },
	openaiImage: { label: 'GPT Image', provider: 'openai', costUsd: 0.04 },
	geminiText: { label: 'Gemini chat', provider: 'gemini', costUsd: 0.002 }
};

/** Map a route key to the model it bills. */
export const ROUTE_COSTS = {
	'generate-animation': 'wan22',
	'remove-background': 'rembg',
	upscale: 'esrgan',
	'reframe-sprite': 'fluxKontext',
	'text-to-image': 'fluxSchnell',
	'live-portrait': 'kling',
	'generate-sprite': 'geminiImage',
	'generate-frames': 'geminiImage',
	'generate-character-sheet': 'geminiImage',
	'generate-styled-character': 'geminiImage',
	'edit-image': 'geminiImage',
	'design-chat': 'geminiText'
};

export function estimateRouteCost(routeKey, metadata = {}) {
	if (routeKey === 'generate-animation' && metadata?.modelId && MODELS[metadata.modelId]) {
		return MODELS[metadata.modelId].costUsd;
	}
	const key = ROUTE_COSTS[routeKey];
	return key ? MODELS[key].costUsd : 0;
}
