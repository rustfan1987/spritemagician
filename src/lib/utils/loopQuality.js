/**
 * Loop quality: does the last frame flow back into the first?
 *
 * The test is simple and matches what the eye does. Measure how much the
 * picture changes between every pair of neighbouring frames (the "steps"),
 * then measure the change from the LAST frame back to the FIRST (the "seam").
 * A seam that is no bigger than an ordinary step is invisible; a seam that is
 * much bigger than the biggest step is the hitch you notice.
 *
 *   ratio = seam / median(step)      ≤ 1.0  perfect   (seam is a normal step)
 *                                    ≤ 1.5  good      (within the loop's own range)
 *                                    ≤ 2.5  visible
 *                                    > 2.5  broken
 *
 * Pure functions here work on greyscale thumbnails (Uint8Array, same length)
 * so the same code runs in Node (scripts/animate.mjs, with sharp) and in the
 * browser (Export panel, with canvas). Keep it dependency free.
 */

/** Mean absolute difference between two equal-length greyscale buffers. */
export function greyDiff(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
	return s / a.length;
}

/**
 * @param {Uint8Array[]} greys one thumbnail per frame, all the same size
 * @returns {{steps:number[], seam:number, median:number, max:number, ratio:number, verdict:string}}
 */
export function seamReport(greys) {
	const n = greys.length;
	if (n < 2) return { steps: [], seam: 0, median: 0, max: 0, ratio: 0, verdict: 'too short' };
	const steps = [];
	for (let i = 0; i < n - 1; i++) steps.push(greyDiff(greys[i], greys[i + 1]));
	const seam = greyDiff(greys[n - 1], greys[0]);
	const sorted = [...steps].sort((p, q) => p - q);
	const median = sorted[Math.floor(sorted.length / 2)] || 0;
	const max = sorted[sorted.length - 1] || 0;
	const ratio = median > 0 ? seam / median : seam > 0 ? Infinity : 0;
	return { steps, seam, median, max, ratio, verdict: seamVerdict(ratio, seam, max) };
}

export function seamVerdict(ratio, seam = 0, max = Infinity) {
	if (ratio <= 1.0) return 'perfect';
	if (ratio <= 1.5 || seam <= max) return 'good';
	if (ratio <= 2.5) return 'visible';
	return 'broken';
}

/**
 * Flatten RGBA onto a mid-grey background and reduce to one grey value per
 * pixel. Flattening matters: a transparent pixel's RGB is garbage, so comparing
 * raw RGBA makes the background "move".
 */
export function rgbaToGrey(rgba, bg = 32) {
	const out = new Uint8Array(rgba.length / 4);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
		const a = rgba[i + 3] / 255;
		const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
		out[j] = l * a + bg * (1 - a);
	}
	return out;
}

// ---------------------------------------------------------------- browser ---

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Failed to load frame'));
		img.src = src;
	});
}

/**
 * Browser: measure loop quality of an array of frame data URLs.
 * Thumbnails are 128 px wide so this is fast even for 100 frames.
 */
export async function measureLoopQuality(frames, { width = 128, onProgress } = {}) {
	const greys = [];
	let h = 0;
	for (let i = 0; i < frames.length; i++) {
		const img = await loadImage(frames[i]);
		if (!h) h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * width));
		const canvas = document.createElement('canvas');
		canvas.width = width; canvas.height = h;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.clearRect(0, 0, width, h);
		ctx.drawImage(img, 0, 0, width, h);
		greys.push(rgbaToGrey(ctx.getImageData(0, 0, width, h).data));
		onProgress?.(i + 1, frames.length);
	}
	return seamReport(greys);
}

/**
 * Browser: build a "seam strip" image — the last `k` frames, a divider, then
 * the first `k` frames — so the join can be read left to right as one motion.
 * @returns {Promise<string>} PNG data URL
 */
export async function buildSeamStrip(frames, { k = 3, cell = 160, gap = 4 } = {}) {
	if (!frames?.length) return '';
	k = Math.min(k, Math.floor(frames.length / 2)) || 1;
	const picks = [...frames.slice(-k), ...frames.slice(0, k)];
	const imgs = await Promise.all(picks.map(loadImage));
	const ratio = imgs[0].naturalHeight / imgs[0].naturalWidth;
	const cw = cell, ch = Math.round(cell * ratio);
	const canvas = document.createElement('canvas');
	canvas.width = picks.length * (cw + gap) + gap * 3;
	canvas.height = ch + gap * 2;
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.imageSmoothingEnabled = false;
	let x = gap;
	imgs.forEach((img, i) => {
		if (i === k) { ctx.fillStyle = '#ef4444'; ctx.fillRect(x, 0, gap * 2, canvas.height); x += gap * 4; }
		ctx.drawImage(img, x, gap, cw, ch);
		x += cw + gap;
	});
	return canvas.toDataURL('image/png');
}
