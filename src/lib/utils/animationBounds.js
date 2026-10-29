/**
 * Crop an animation to the union of its frames' silhouettes.
 *
 * Per-frame trimming makes sprites jitter because every frame gets a
 * different box. This measures the opaque bounding box of EVERY frame, takes
 * the union, adds padding, and crops all frames to that one box, so the
 * character keeps its position and nothing is ever cut off.
 *
 * Browser-only (uses canvas). The headless twin lives in scripts/animate.mjs
 * (alphaBox / unionBox).
 */

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Failed to load frame'));
		img.src = src;
	});
}

/** @returns {{x0:number,y0:number,x1:number,y1:number}|null} */
export function alphaBoundsOfImageData(data, width, height, threshold = 16) {
	let minX = width, maxX = -1, minY = height, maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] > threshold) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	return maxX < 0 ? null : { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
}

/**
 * Measure the union box of all frames.
 * @param {string[]} frames data URLs (same size)
 * @returns {Promise<{box:{x0,y0,x1,y1}|null, width:number, height:number}>}
 */
export async function measureAnimationBounds(frames, onProgress) {
	let union = null, width = 0, height = 0;
	for (let i = 0; i < frames.length; i++) {
		const img = await loadImage(frames[i]);
		width = img.naturalWidth; height = img.naturalHeight;
		const canvas = document.createElement('canvas');
		canvas.width = width; canvas.height = height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);
		const box = alphaBoundsOfImageData(ctx.getImageData(0, 0, width, height).data, width, height);
		if (box) {
			union = union
				? { x0: Math.min(union.x0, box.x0), y0: Math.min(union.y0, box.y0), x1: Math.max(union.x1, box.x1), y1: Math.max(union.y1, box.y1) }
				: box;
		}
		onProgress?.(i + 1, frames.length);
	}
	return { box: union, width, height };
}

/**
 * Crop every frame to the union box (+ padding). Returns new data URLs and the
 * box that was used. Frames without any opaque pixel are returned unchanged.
 * @param {string[]} frames
 * @param {{padding?:number, onProgress?:(done:number,total:number)=>void}} [opts]
 */
export async function cropToAnimationBounds(frames, { padding = 4, onProgress } = {}) {
	if (!frames?.length) return { frames: frames || [], box: null };
	const { box, width, height } = await measureAnimationBounds(frames, onProgress);
	if (!box) return { frames, box: null };
	const x = Math.max(0, box.x0 - padding), y = Math.max(0, box.y0 - padding);
	const w = Math.min(width, box.x1 + padding) - x, h = Math.min(height, box.y1 + padding) - y;
	if (w <= 0 || h <= 0 || (x === 0 && y === 0 && w === width && h === height)) return { frames, box: { x, y, w, h } };
	const out = [];
	for (let i = 0; i < frames.length; i++) {
		const img = await loadImage(frames[i]);
		const canvas = document.createElement('canvas');
		canvas.width = w; canvas.height = h;
		canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
		out.push(canvas.toDataURL('image/png'));
		onProgress?.(i + 1, frames.length);
	}
	return { frames: out, box: { x, y, w, h } };
}
