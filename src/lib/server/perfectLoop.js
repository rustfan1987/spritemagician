/**
 * Perfect-loop pipeline, server side. One call turns a sprite into a set of
 * seamlessly looping animations and files them in the library.
 *
 * This is the pipeline from scripts/animate.mjs moved into the app so the UI
 * needs one button instead of a dozen knobs. The script's header documents
 * every step and every failed attempt; keep the two in sync (the script now
 * mostly drives this through /api/perfect-loop).
 *
 *   0. cutout      source → transparent (rembg once, only if it has no alpha);
 *                  optional profile redraw for side-scroller sets (FLUX Kontext)
 *   1. canvas      832×480 chroma green, sprite at 60 % height, crop-back
 *                  buffer 40 % of the sprite height on every side
 *   2. prompt      subject → motion beats → end state → static camera
 *   3. generate    Wan 2.2 i2v fast, 81 frames @ 16 fps; one-shots anchored
 *                  with last_image = input, cycles NOT anchored
 *   4. loop        one-shot: frames 0..79 thinned to N (≈10 fps)
 *                  cycle: best matching frame pair a stride or two apart,
 *                  seam measured after re-centring, native 16 fps
 *   5. frames      crop back, resize, local chroma key, colour match
 *   6. check       seam / median step ratio (src/lib/utils/loopQuality.js)
 *   7. union crop  one box for the whole set, nothing clipped, shared canvas
 *   8. save        .anim.json + thumbnail, indexed in the library folder
 *
 * Progress is published through generationProgress so the client polls the
 * same /api/generation-progress endpoint it already uses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { createPrediction, waitForPrediction, runPrediction, toReplicateInput } from '$lib/server/replicate.js';
import { fetchImageBuffer, saveBuffer, saveDataUrl, localUrlToDataUrl, isLocalUrl } from '$lib/server/localFiles.js';
import { getDataDir } from '$lib/server/paths.js';
import { createFileFromUrl, getChildren, deleteItem, createFolder } from '$lib/server/library.js';
import { recordUsageEvent } from '$lib/server/requestTracking.js';
import { setProgress, clearProgress } from '$lib/utils/generationProgress.js';
import { presetById } from '$lib/animation/presets.js';
import { seamReport, rgbaToGrey, greyDiff } from '$lib/utils/loopQuality.js';

const CHROMA = '#00FF00';
const CANVAS = { width: 832, height: 480 };
const FILL = 0.6;
const MARGIN = 0.4;
const WAN_MODEL = 'wan-video/wan-2.2-i2v-fast';
const REMBG_VERSION = 'fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003';
const KONTEXT_MODEL = 'black-forest-labs/flux-kontext-pro';
const SIDE_PROMPT = 'Redraw this exact character in a strict full side profile view facing RIGHT, standing upright in a neutral pose, feet on the same ground line, arms relaxed at the sides. Same proportions, colors, clothing, materials and art style. Whole body visible, nothing cropped. Keep the plain flat background exactly as it is.';

export const PERFECT_LOOP_DEFAULTS = { frames: 48, size: 768, pad: 6 };

// ───────────────────────────────────────────────────────────── prompt ───
/** Wan 2.2 prompt recipe: subject → motion beats → end state → static camera. */
export function buildPerfectLoopPrompt(action, { subject = '', view = 'front' } = {}) {
	const a = String(action || '').trim().replace(/[.\s]+$/, '');
	const who = subject ? `${subject.trim().replace(/[.\s]+$/, '')}. ` : '';
	const facing = view === 'side' && !/profile view/i.test(a) ? 'Seen in full side profile, facing right. ' : '';
	return `${who}${facing}${a}. The whole body stays inside the frame on the same spot. Static shot, locked camera, no zoom, no pan. Flat solid ${CHROMA} green background.`;
}

/** Resolve "id" / {id, text} into {id, text, mode: 'cycle'|'oneshot'}. */
export function resolveAction(spec) {
	const id = String(typeof spec === 'string' ? spec : spec?.id || '').trim();
	const override = typeof spec === 'object' ? String(spec?.text || '').trim() : '';
	const p = presetById(id);
	const text = override || (p ? p.description : id);
	const cyclic = /(^|[^a-z])(cycle|walk|walks|run|runs|idle|march|sneak|sprint|channel|breath|breathing|hover|float)([^a-z]|$)/i.test(id.replace(/_/g, ' ') + ' ' + text);
	const safeId = (p ? p.id : id.toLowerCase().replace(/[^a-z0-9]+/g, '_')).slice(0, 30) || 'action';
	return { id: safeId, name: p?.name || id, text, mode: cyclic ? 'cycle' : 'oneshot' };
}

// ───────────────────────────────────────────────────────────── ffmpeg ───
/**
 * ffmpeg lookup order: FFMPEG_PATH → `ffmpeg` on PATH → the binary shipped
 * with the app (ffmpeg-static, unpacked next to the asar in the installer).
 * Resolved once; `ffmpegAvailable()` reports which one is in use.
 */
let resolvedFfmpeg;
function works(bin) {
	try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
async function bundledFfmpeg() {
	try {
		const mod = await import('ffmpeg-static');
		const p = String(mod.default || mod || '').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
		return p && fs.existsSync(p) ? p : null;
	} catch { return null; }
}
export async function resolveFfmpeg() {
	if (resolvedFfmpeg !== undefined) return resolvedFfmpeg;
	const candidates = [process.env.FFMPEG_PATH, 'ffmpeg', await bundledFfmpeg()].filter(Boolean);
	resolvedFfmpeg = candidates.find(works) || null;
	return resolvedFfmpeg;
}
function ffmpegBin() {
	return resolvedFfmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
}
export async function ffmpegAvailable() {
	return !!(await resolveFfmpeg());
}
function extractAllFrames(videoPath, dir) {
	fs.mkdirSync(dir, { recursive: true });
	try {
		execFileSync(ffmpegBin(), ['-y', '-loglevel', 'error', '-i', videoPath, '-vsync', '0', path.join(dir, 'f_%04d.png')], { stdio: ['ignore', 'ignore', 'pipe'] });
	} catch (err) {
		throw new Error(`ffmpeg failed (${err.stderr?.toString().trim() || err.message}). Install ffmpeg and make sure it is on PATH, or set FFMPEG_PATH in Settings.`);
	}
	return fs.readdirSync(dir).filter((f) => f.startsWith('f_')).sort().map((f) => path.join(dir, f));
}

// ───────────────────────────────────────────────────────────── inputs ───
async function loadSourceBuffer(image) {
	if (typeof image !== 'string' || !image) throw new Error('image is required');
	if (image.startsWith('data:')) return Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
	if (isLocalUrl(image)) return Buffer.from(localUrlToDataUrl(image).split(',')[1], 'base64');
	const { buffer } = await fetchImageBuffer(image);
	return buffer;
}

async function ensureCutout(buf, log) {
	const meta = await sharp(buf).metadata();
	if (meta.hasAlpha) {
		const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		let transparent = 0;
		for (let i = 3; i < data.length; i += 4) if (data[i] < 10) transparent++;
		if (transparent / (info.width * info.height) > 0.05) return buf;
	}
	log('Removing the background (rembg)…');
	const prediction = await createPrediction({ version: REMBG_VERSION, input: { image: await toReplicateInput(`data:image/png;base64,${(await sharp(buf).png().toBuffer()).toString('base64')}`) } });
	const result = await waitForPrediction(prediction, { intervalMs: 1000, maxMs: 180_000 });
	const { buffer } = await fetchImageBuffer(result.output);
	return buffer;
}

async function reframeToSide(buf, log) {
	log('Redrawing the sprite in side profile (FLUX Kontext)…');
	const input = {
		prompt: SIDE_PROMPT,
		input_image: await toReplicateInput(`data:image/png;base64,${buf.toString('base64')}`),
		aspect_ratio: 'match_input_image', output_format: 'png', safety_tolerance: 2, prompt_upsampling: false
	};
	const result = await runPrediction({ model: KONTEXT_MODEL, input, maxMs: 180_000 });
	const out = Array.isArray(result.output) ? result.output[0] : result.output;
	if (!out) throw new Error('Reframe returned no image');
	const { buffer } = await fetchImageBuffer(out);
	return buffer;
}

async function prepareCanvas(cutout) {
	const trimmed = await sharp(cutout).trim().png().toBuffer();
	const m = await sharp(trimmed).metadata();
	const scale = Math.min((CANVAS.height * FILL) / m.height, (CANVAS.width * FILL) / m.width);
	const w = Math.round(m.width * scale), h = Math.round(m.height * scale);
	const x = Math.round((CANVAS.width - w) / 2), y = Math.round((CANVAS.height - h) / 2);
	const sprite = await sharp(trimmed).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer();
	const canvas = await sharp({ create: { width: CANVAS.width, height: CANVAS.height, channels: 4, background: CHROMA } })
		.composite([{ input: sprite, left: x, top: y }]).png().toBuffer();
	const mx = Math.round(h * MARGIN), my = Math.round(h * MARGIN);
	const cx = Math.max(0, x - mx), cy = Math.max(0, y - my);
	const cw = Math.min(CANVAS.width, x + w + mx) - cx, ch = Math.min(CANVAS.height, y + h + my) - cy;
	return { canvas, crop: { x: cx, y: cy, w: cw, h: ch } };
}

// ───────────────────────────────────────────────────────────── generate ───
function cacheDir() {
	const dir = path.join(getDataDir(), '.cache', 'wan');
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Same canvas + prompt + seed + anchor ⇒ same video; cache it on disk. */
async function generateVideo(canvasPng, prompt, seed, anchor, onTick) {
	const key = crypto.createHash('sha1').update(canvasPng).update(prompt).update(String(seed)).update(anchor ? 'A' : 'N').digest('hex').slice(0, 16);
	const cached = path.join(cacheDir(), key + '.mp4');
	if (fs.existsSync(cached)) return { path: cached, cached: true };
	const imageUrl = await toReplicateInput(`data:image/png;base64,${canvasPng.toString('base64')}`);
	const input = {
		prompt, image: imageUrl, num_frames: 81, frames_per_second: 16, resolution: '480p',
		...(anchor && { last_image: imageUrl }), seed
	};
	const prediction = await createPrediction({ model: WAN_MODEL, input });
	const result = await waitForPrediction(prediction, { intervalMs: 1500, maxMs: 300_000, onTick });
	const { buffer } = await fetchImageBuffer(result.output);
	fs.writeFileSync(cached, buffer);
	return { path: cached, cached: false };
}

// ───────────────────────────────────────────────────────────── analysis ───
function keyGreen(data) {
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i], g = data[i + 1], b = data[i + 2];
		const maxRB = Math.max(r, b);
		const dom = g - maxRB;
		if (g > 90 && dom > 40) {
			const a = dom > 110 ? 0 : Math.round(255 * (1 - (dom - 40) / 70));
			data[i + 3] = Math.min(data[i + 3], a);
			if (a > 0) data[i + 1] = maxRB;
		} else if (dom > 10 && g > 60) {
			data[i + 1] = Math.round(maxRB + dom * 0.4);
		}
	}
	return data;
}

async function analyzeFrames(framePaths, crop) {
	const out = [];
	for (const f of framePaths) {
		const img = sharp(f);
		const m = await img.metadata();
		const sx = m.width / CANVAS.width, sy = m.height / CANVAS.height;
		const { data, info } = await img
			.extract({ left: Math.round(crop.x * sx), top: Math.round(crop.y * sy), width: Math.round(crop.w * sx), height: Math.round(crop.h * sy) })
			.resize(128, null, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		keyGreen(data);
		let sum = 0, sxx = 0, syy = 0, minX = info.width, maxX = 0, minY = info.height, maxY = 0;
		for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
			const a = data[(y * info.width + x) * 4 + 3];
			if (a < 64) continue;
			sum++; sxx += x; syy += y;
			if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
		}
		const scale = crop.w / info.width;
		out.push({
			cx: sum ? (sxx / sum) * scale : crop.w / 2, cy: sum ? (syy / sum) * scale : crop.h / 2,
			w: sum ? (maxX - minX + 1) * scale : 0, h: sum ? (maxY - minY + 1) * scale : 0,
			grey: rgbaToGrey(data), tw: info.width, scale, area: sum
		});
	}
	return out;
}

function greyDiffShift(a, b, w, shift) {
	if (!shift) return greyDiff(a, b);
	let s = 0; const h = a.length / w;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const xb = x + shift;
		s += Math.abs(a[y * w + x] - (xb >= 0 && xb < w ? b[y * w + xb] : 32));
	}
	return s / a.length;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const std = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

/** Which native frames make the loop, and how far to re-centre each. */
function pickLoop(analysis, mode, n) {
	const total = analysis.length;
	if (mode === 'cycle') {
		const minLen = 12, maxLen = Math.min(48, total - 2);
		const w = analysis[0].tw, px = analysis[0].scale;
		const step = analysis.slice(1).map((f, k) => greyDiff(f.grey, analysis[k].grey));
		let best = null;
		for (let i = 2; i + minLen < total; i++) {
			for (let j = i + minLen; j <= Math.min(total - 1, i + maxLen); j++) {
				const win = analysis.slice(i, j);
				const med = median(step.slice(i, j - 1)) || 1;
				const shift = Math.round((analysis[i].cx - analysis[j - 1].cx) / px);
				const seam = greyDiffShift(analysis[j - 1].grey, analysis[i].grey, w, shift);
				const drift = std(win.map((a) => a.h)) / (analysis[i].h || 1);
				const score = seam / med - (j - i) * 0.004 + drift * 2;
				if (!best || score < best.score) best = { i, j, score };
			}
		}
		if (!best) return { frames: analysis.map((_, i) => ({ index: i, dx: 0 })), fps: 16 };
		const idx = Array.from({ length: best.j - best.i }, (_, k) => best.i + k);
		const cx0 = median(idx.map((i) => analysis[i].cx));
		return { frames: idx.map((i) => ({ index: i, dx: analysis[i].cx - cx0 })), fps: 16 };
	}
	// one-shot: anchored clip, frame 80 ≈ frame 0 → use 0..79 thinned to n
	const usable = total - 1;
	const idx = usable <= n ? Array.from({ length: usable }, (_, i) => i) : Array.from({ length: n }, (_, k) => Math.round((usable * k) / n));
	const fps = Math.max(6, Math.round((16 * idx.length) / usable));
	return { frames: idx.map((i) => ({ index: i, dx: 0 })), fps };
}

async function cropAndKey(framePath, crop, outW, outH, dx = 0) {
	const img = sharp(framePath);
	const m = await img.metadata();
	const sx = m.width / CANVAS.width, sy = m.height / CANVAS.height;
	const left = Math.max(0, Math.min(m.width - Math.round(crop.w * sx), Math.round((crop.x + dx) * sx)));
	const { data, info } = await img
		.extract({ left, top: Math.round(crop.y * sy), width: Math.round(crop.w * sx), height: Math.round(crop.h * sy) })
		.resize(outW, outH, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data: keyGreen(data), info };
}

function rgbStats(buffers) {
	const sum = [0, 0, 0], sq = [0, 0, 0];
	let n = 0;
	for (const data of buffers) for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 200) continue;
		n++;
		for (let c = 0; c < 3; c++) { sum[c] += data[i + c]; sq[c] += data[i + c] * data[i + c]; }
	}
	if (!n) return null;
	return [0, 1, 2].map((c) => { const m = sum[c] / n; return { mean: m, std: Math.sqrt(Math.max(1, sq[c] / n - m * m)) }; });
}
function colorMatch(frames, ref) {
	if (!ref) return frames;
	const cur = rgbStats(frames.map((f) => f.data));
	if (!cur) return frames;
	const gain = [0, 1, 2].map((c) => Math.max(0.7, Math.min(1.4, ref[c].std / cur[c].std)));
	const shift = [0, 1, 2].map((c) => ref[c].mean - cur[c].mean * gain[c]);
	for (const f of frames) for (let i = 0; i < f.data.length; i += 4) {
		if (f.data[i + 3] === 0) continue;
		for (let c = 0; c < 3; c++) f.data[i + c] = Math.max(0, Math.min(255, Math.round(f.data[i + c] * gain[c] + shift[c])));
	}
	return frames;
}
function alphaBox({ data, info }) {
	let minX = info.width, maxX = -1, minY = info.height, maxY = -1;
	for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
		if (data[(y * info.width + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
	}
	return maxX < 0 ? null : { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
}
function unionBox(boxes) {
	const b = boxes.filter(Boolean);
	if (!b.length) return null;
	return { x0: Math.min(...b.map((x) => x.x0)), y0: Math.min(...b.map((x) => x.y0)), x1: Math.max(...b.map((x) => x.x1)), y1: Math.max(...b.map((x) => x.y1)) };
}
async function loopReport(frames) {
	const greys = [];
	for (const f of frames) {
		const { data } = await sharp(f.data, { raw: f.info }).resize(128, null, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		greys.push(rgbaToGrey(data));
	}
	const r = seamReport(greys);
	return { seam: +r.seam.toFixed(2), median: +r.median.toFixed(2), max: +r.max.toFixed(2), ratio: +r.ratio.toFixed(2), verdict: r.verdict };
}

// ───────────────────────────────────────────────────────────── job ───
/**
 * @param {object} o
 * @param {string} o.jobId
 * @param {string} o.uid
 * @param {string} o.image        data URL / local URL / https URL of the sprite
 * @param {Array<string|{id:string,text?:string}>} o.actions
 * @param {string} [o.subject]    2–4 identifying features
 * @param {'front'|'side'} [o.view]
 * @param {boolean} [o.reframe]   redraw a front sprite in profile first (view=side)
 * @param {number} [o.seed]
 * @param {string} [o.name]       file name prefix
 * @param {string|null} [o.folderId]  library folder (default: Characters/)
 * @param {boolean} [o.replace]   delete same-named animations first
 * @param {number} [o.frames] [o.size] [o.pad]
 */
export async function runPerfectLoopJob(o) {
	const { jobId, uid } = o;
	const actions = (o.actions || []).map(resolveAction);
	const seed = Number.isFinite(Number(o.seed)) ? Number(o.seed) : Math.floor(Math.random() * 2_147_483_647);
	const view = o.view === 'side' ? 'side' : 'front';
	const subject = String(o.subject || '').slice(0, 300);
	const name = String(o.name || 'sprite').slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '_') || 'sprite';
	const N = Math.max(8, Math.min(96, Number(o.frames) || PERFECT_LOOP_DEFAULTS.frames));
	const SIZE = Math.max(128, Math.min(1024, Number(o.size) || PERFECT_LOOP_DEFAULTS.size));
	const PAD = Math.max(0, Math.min(64, Number(o.pad ?? PERFECT_LOOP_DEFAULTS.pad)));
	const state = { status: 'starting', message: 'Preparing the sprite…', seed, view, actions: actions.map((a) => ({ id: a.id, name: a.name, mode: a.mode, status: 'pending' })), results: [], currentFrame: 0, totalFrames: actions.length };
	const publish = (patch = {}) => setProgress(jobId, Object.assign(state, patch));
	const setAction = (i, patch) => { state.actions[i] = { ...state.actions[i], ...patch }; publish(); };
	const log = (message) => publish({ message });
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-loop-'));
	try {
		if (!actions.length) throw new Error('Pick at least one action');
		if (!(await ffmpegAvailable())) throw new Error('ffmpeg was not found. Install it (https://ffmpeg.org) and make sure it is on PATH, then try again.');
		publish({ status: 'processing' });
		let cutout = await ensureCutout(await loadSourceBuffer(o.image), log);
		if (view === 'side' && o.reframe) cutout = await ensureCutout(await reframeToSide(cutout, log), log);
		const sourceStats = rgbStats([(await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data]);
		const { canvas, crop } = await prepareCanvas(cutout);
		const outW = Math.round(crop.w * (SIZE / Math.max(crop.w, crop.h)));
		const outH = Math.round(crop.h * (SIZE / Math.max(crop.w, crop.h)));
		const done = [];
		for (let i = 0; i < actions.length; i++) {
			const a = actions[i];
			const prompt = buildPerfectLoopPrompt(a.text, { subject, view });
			const anchor = a.mode !== 'cycle';
			setAction(i, { status: 'generating' });
			try {
				log(`${a.name}: generating with Wan 2.2…`);
				const video = await generateVideo(canvas, prompt, seed, anchor, (p, ms) => log(`${a.name}: ${p.status}… (${Math.round(ms / 1000)}s)`));
				if (!video.cached) await recordUsageEvent({ uid, routeKey: 'generate-animation', provider: 'replicate', statusCode: 200, metadata: { modelId: 'wan22', perfectLoop: true, action: a.id } });
				log(`${a.name}: finding the loop…`);
				setAction(i, { status: 'processing' });
				const all = extractAllFrames(video.path, path.join(tmp, a.id));
				const analysis = await analyzeFrames(all, crop);
				const picked = pickLoop(analysis, a.mode, N);
				let frames = [];
				for (const c of picked.frames) frames.push(await cropAndKey(all[c.index], crop, outW, outH, c.dx));
				colorMatch(frames, sourceStats);
				const loop = await loopReport(frames);
				const box = unionBox(frames.map(alphaBox));
				const touchesEdge = box && (box.x0 === 0 || box.y0 === 0 || box.x1 === outW || box.y1 === outH);
				done.push({ a, prompt, frames, fps: picked.fps, box, loop, touchesEdge });
				setAction(i, { status: 'checked', loop, frames: frames.length, fps: picked.fps, touchesEdge });
			} catch (err) {
				setAction(i, { status: 'failed', error: err.message });
			}
		}
		if (!done.length) throw new Error(state.actions.find((x) => x.error)?.error || 'Every action failed');

		// union crop for the whole set
		const setBox = unionBox(done.map((d) => d.box));
		const bx = Math.max(0, setBox.x0 - PAD), by = Math.max(0, setBox.y0 - PAD);
		const bw = Math.min(outW, setBox.x1 + PAD) - bx, bh = Math.min(outH, setBox.y1 + PAD) - by;
		const folderId = o.folderId || (getChildren(null).find((f) => f.isFolder && f.name === 'Characters') || createFolder(null, 'Characters')).id;
		for (const d of done) {
			const i = actions.indexOf(d.a);
			log(`${d.a.name}: saving…`);
			const pngs = [];
			for (const f of d.frames) pngs.push(await sharp(f.data, { raw: f.info }).extract({ left: bx, top: by, width: bw, height: bh }).png().toBuffer());
			const dataUrls = pngs.map((b) => `data:image/png;base64,${b.toString('base64')}`);
			const fileName = `${name}-${d.a.id}`;
			const ts = Date.now();
			const thumbnailUrl = saveDataUrl(dataUrls[0], `.thumbs/${fileName}_${ts}_thumb`).url;
			const anim = { type: 'animation', name: fileName, frames: dataUrls, fps: d.fps, frameCount: dataUrls.length, prompt: d.prompt, thumbnailUrl, createdAt: new Date().toISOString(), loop: true, loopCheck: d.loop };
			const saved = saveBuffer(Buffer.from(JSON.stringify(anim), 'utf-8'), `.animations/${fileName}_${ts}.anim.json`);
			if (o.replace) for (const old of getChildren(folderId).filter((it) => !it.isFolder && it.name === `${fileName}.anim.json`)) deleteItem(old.id);
			const item = createFileFromUrl(folderId, `${fileName}.anim.json`, saved.url, 'animation', {
				thumbnailUrl, frameCount: dataUrls.length, fps: d.fps, seed, pose: d.a.id, loop: 'perfect', loopCheck: d.loop, view, source: 'perfect-loop'
			});
			state.results.push({ action: d.a.id, name: d.a.name, mode: d.a.mode, frames: dataUrls.length, fps: d.fps, size: `${bw}x${bh}`, loop: d.loop, touchesEdge: d.touchesEdge, url: saved.url, thumbnailUrl, fileId: item.id, fileName: item.name });
			setAction(i, { status: 'done', fileId: item.id, url: saved.url, thumbnailUrl });
			publish({ currentFrame: state.results.length });
		}
		publish({ status: 'completed', message: `Done: ${done.length} animation${done.length === 1 ? '' : 's'} saved (${bw}×${bh}).`, folderId });
	} catch (err) {
		console.error('[perfect-loop]', err);
		publish({ status: 'error', message: err.message });
	} finally {
		try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
		setTimeout(() => clearProgress(jobId), 10 * 60_000);
	}
}
