/**
 * Post-processing pipeline for a generated animation video.
 *
 *   video → frames → crop back to sprite → loop shaping → background
 *   removal → pixel-art pass → canvas padding
 *
 * Used by the Animate panel and by character batch generation so both
 * produce identical results from identical settings.
 *
 * AI AGENTS: the same pipeline exists headless in scripts/animate.mjs with a
 * long header documenting framing margins, window selection, drift
 * re-centring and static-frame removal that were learned by producing real
 * batches. If you change framing or loop logic here, mirror it there (and
 * vice versa). See AGENTS.md.
 */
import { extractFrames } from '$lib/utils/videoFrameExtractor.js';
import { pixelateFrames } from '$lib/utils/pixelate.js';
import { addCanvasPadding } from '$lib/utils/canvasPadding.js';
import { cropFramesBack } from './wanCanvas.js';

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Failed to load frame'));
		img.src = src;
	});
}

async function blendFrames(aUrl, bUrl, alpha) {
	const [a, b] = await Promise.all([loadImage(aUrl), loadImage(bUrl)]);
	const canvas = document.createElement('canvas');
	canvas.width = a.naturalWidth;
	canvas.height = a.naturalHeight;
	const ctx = canvas.getContext('2d');
	ctx.drawImage(a, 0, 0);
	ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
	ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL('image/png');
}

/** Cross-fade the tail into the head and hard-close the loop. */
export async function enforcePerfectLoop(frames) {
	if (!frames || frames.length < 4) return frames || [];
	const out = [...frames];
	const seam = Math.min(4, Math.max(2, Math.floor(out.length / 6)));
	for (let i = 0; i < seam; i++) {
		const tail = out.length - seam + i;
		out[tail] = await blendFrames(out[tail], out[i], (i + 1) / (seam + 1));
	}
	out[out.length - 1] = out[0];
	return out;
}

export function pingPong(frames) {
	if (!frames || frames.length < 3) return frames || [];
	const half = Math.ceil(frames.length / 2);
	return [...frames.slice(0, half), ...frames.slice(1, half - 1).reverse()];
}

/** Remove backgrounds in batches of four through /api/remove-background. */
export async function removeBackgrounds(frames, onProgress) {
	const out = [...frames];
	const batchSize = 4;
	let done = 0;
	for (let i = 0; i < out.length; i += batchSize) {
		const batch = out.slice(i, i + batchSize);
		const res = await fetch('/api/remove-background', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ images: batch })
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.error || 'Background removal failed');
		if (!Array.isArray(data?.images)) throw new Error('Background removal returned no images');
		for (let j = 0; j < batch.length; j++) {
			out[i + j] = data.images[j] || out[i + j];
			done += 1;
			onProgress?.(done, out.length);
		}
	}
	return out;
}

/**
 * @typedef {Object} PipelineOptions
 * @property {string} videoUrl
 * @property {number} targetFrameCount   frames to keep (evenly sampled)
 * @property {{x:number,y:number,w:number,h:number}} [crop]   from prepareWanInput
 * @property {{w:number,h:number}} [original]
 * @property {'none'|'pingpong'|'perfect'} [loopMode]
 * @property {boolean} [removeBackground]
 * @property {{enabled:boolean, pixelSize:number, colorLevels:number}} [pixelate]
 * @property {number} [canvasPadding]
 * @property {(message:string)=>void} [onProgress]
 */

/** @param {PipelineOptions} opts @returns {Promise<string[]>} */
export async function finalizeVideo(opts) {
	const {
		videoUrl, targetFrameCount, crop, original,
		loopMode = 'none', removeBackground = false,
		pixelate = { enabled: false, pixelSize: 4, colorLevels: 8 },
		canvasPadding = 0, onProgress = () => {}
	} = opts;

	onProgress('Extracting frames from video...');
	let frames = await extractFrames(videoUrl, targetFrameCount);
	if (!frames?.length) throw new Error('No frames extracted from video');

	if (crop && original) {
		onProgress('Cropping frames back to sprite size...');
		frames = await cropFramesBack(frames, crop, original, (d, t) => onProgress(`Cropping (${d}/${t})...`));
	}

	if (loopMode === 'perfect' && frames.length > 3) {
		onProgress('Closing the loop seam...');
		frames = await enforcePerfectLoop(frames);
	} else if (loopMode === 'pingpong' && frames.length > 2) {
		onProgress('Creating ping-pong loop...');
		frames = pingPong(frames);
	}

	if (removeBackground) {
		frames = await removeBackgrounds(frames, (d, t) => onProgress(`Removing background (${d}/${t})...`));
	}

	if (pixelate?.enabled && frames.length) {
		frames = await pixelateFrames(frames, pixelate.pixelSize, pixelate.colorLevels, (d, t) =>
			onProgress(`Pixelating (${d}/${t})...`)
		);
	}

	if (canvasPadding > 0 && frames.length) {
		frames = await addCanvasPadding(frames, canvasPadding, (d, t) => onProgress(`Padding (${d}/${t})...`));
	}

	return frames;
}

/**
 * Poll /api/generation-progress until the job has a video or fails.
 * @returns {Promise<{videoUrl:string}>}
 */
export function waitForJob(jobId, { onProgress = () => {}, intervalMs = 1500 } = {}) {
	return new Promise((resolve, reject) => {
		const timer = setInterval(async () => {
			try {
				const res = await fetch(`/api/generation-progress?jobId=${encodeURIComponent(jobId)}`);
				if (!res.ok) return;
				const data = await res.json();
				onProgress(data);
				if (data.status === 'completed' && data.videoUrl) {
					clearInterval(timer);
					resolve({ videoUrl: data.videoUrl });
				} else if (data.status === 'error') {
					clearInterval(timer);
					reject(new Error(data.message || 'Generation failed'));
				}
			} catch (err) {
				console.warn('[pipeline] poll error', err);
			}
		}, intervalMs);
	});
}

/** Build a short Wan prompt: the action, plus a fixed framing clause. */
export function buildWanPrompt(action, chromaHex) {
	const a = String(action || '').trim().replace(/[.\s]+$/, '');
	return `${a}. Flat solid ${chromaHex} green background, fixed camera, no zoom, character stays centered.`;
}
