#!/usr/bin/env node
/**
 * scripts/animate.mjs — headless sprite → looping animation pipeline.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ NOTES FOR AI AGENTS (read this before automating animations)            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * This script reproduces what the Animate panel does in the browser, but from
 * Node, against a running Sprite Magician server (`npm run dev` or the Electron
 * app). It was written while producing the first batch of looping animations
 * for the bundled scarecrow sprite, and every step below encodes something
 * that was learned the hard way. Keep the order; each step exists for a reason.
 *
 *   0. Source must be transparent. A sprite on a black/white card confuses
 *      the video model (it animates the card). If the PNG has no alpha, we run
 *      it through /api/remove-background once (≈$0.002) and cache the result
 *      next to the source as <name>.cutout.png.
 *
 *   1. Paint the sprite on a 832×480 chroma-green canvas (#00FF00) at ~62 % of
 *      the canvas height. Wan 2.2 works at 480p 16:9; a small sprite in a big
 *      frame smears into mush, but a sprite that fills the frame gets its arms
 *      and legs cut off the moment it jumps, swings or staggers (learned on the
 *      first jump test: hands clipped at the crop edge). Crop back with a
 *      ~22 % margin on every side so wide poses survive. Remember the crop
 *      rectangle — we need it later.
 *
 *   2. Prompt = ONE short action sentence + fixed framing clause (see
 *      buildWanPrompt in src/lib/animation/pipeline.js). Long prompts make
 *      Wan improvise. Always include "fixed camera, no zoom" and the green
 *      background, otherwise the camera drifts and the key fails.
 *
 *   3. Ask for 81 frames @ 16 fps (≈5 s). That is Wan 2.2's minimum and its
 *      sweet spot; shorter requests are padded anyway and longer ones drift.
 *      Cost ≈ $0.05 per clip on wan-2.2-i2v-fast.
 *
 *   4. Extract ALL native frames with ffmpeg. Do not let ffmpeg resample fps.
 *
 *   5. Pick a window. Two kinds of action:
 *        cycle   (walk, run, idle)  → take N CONSECUTIVE native frames from the
 *                                     middle of the clip. Skip the first ~8
 *                                     frames (the model "wakes up" there).
 *                                     Consecutive frames keep stride timing
 *                                     smooth; evenly-sampling 5 s of walking
 *                                     into 24 frames looks like a strobe.
 *        oneshot (jump, hit, attack) → the whole clip IS the action, so sample
 *                                     N frames EVENLY across frames 4..end-4.
 *                                     The model usually returns to the start
 *                                     pose by itself, which makes it loop.
 *
 *   6. Crop every frame back to the sprite rectangle and resize to the output
 *      size (default: longest side 512 px). Payloads of 24×1024² PNGs blow
 *      past request limits and nobody needs 1024 px animation frames.
 *
 *   7. Chroma key locally. We painted the green ourselves, so keying it out is
 *      free and deterministic. Do NOT pay for per-frame rembg here. The key is
 *      "green dominant" (g > 1.5·r and g > 1.5·b and g > 90) with a soft edge
 *      and spill suppression; see keyGreen().
 *
 *   8. Close the loop: cross-fade the last `seam` frames into the first ones.
 *      Never append a copy of frame 0 at the end (it causes a visible hitch).
 *
 *   9. Save through /api/save-animation (writes .anim.json + thumbnail into
 *      <dataDir>/library/.animations) and then index it with
 *      /api/library createFile so it appears in the file tree, exactly like
 *      the UI does. Also drop a GIF next to the source for quick eyeballing.
 *
 * Things that did NOT work and should not be retried without new evidence:
 *   • Passing the 1024×1024 sprite directly (no canvas) — tiny, blurry output.
 *   • "Perfect loop" via a first-frame=last-frame model for cycles — pricier
 *     and it freezes the middle of walk cycles. Seam blending is enough.
 *   • Evenly sampling cycles (see step 5).
 *   • Rembg per frame — slow, costs money, and flickers edge pixels between
 *     frames. Chroma key is stable frame-to-frame.
 *
 * Usage:
 *   node scripts/animate.mjs --image "static/Example images/image.png" \
 *        --actions jump,hit,run_in_place_clean,walk_in_place_clean,attack \
 *        --name scarecrow [--folder Characters] [--fps 12] [--frames 24] \
 *        [--seed 42] [--server http://127.0.0.1:5173] [--out out/anim] [--replace]
 *
 * Action ids are the preset ids in src/lib/animation/presets.js. Write
 * "id=Some custom description" to keep the id for the file name but send your
 * own text to the model (separate actions with ';' if the text has commas).
 * Unknown ids are used verbatim as the description and treated as oneshot
 * unless they contain "cycle", "walk", "run" or "idle". --replace deletes an
 * older animation of the same name in the target folder before indexing.
 *
 * LOOK AT THE CHARACTER BEFORE PICKING PRESETS. The stock "attack" preset says
 * "weapon swing"; given an unarmed scarecrow, Wan happily conjured a staff out
 * of nothing. Use attack_claw_swipe (or a custom description) for unarmed
 * characters, and never mention props the sprite does not have.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { POSE_PRESETS, presetById } from '../src/lib/animation/presets.js';

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
	process.argv.slice(2).map((a, i, arr) => {
		if (!a.startsWith('--')) return [];
		const k = a.slice(2);
		const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true';
		return [k, v];
	}).filter((p) => p.length)
);
const SERVER = (args.server || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const IMAGE = args.image || 'static/Example images/image.png';
const NAME = args.name || path.basename(IMAGE).replace(/\.[^.]+$/, '');
// Separate actions with ';' when a custom description contains commas.
const rawActions = String(args.actions || 'idle');
const ACTIONS = rawActions.split(rawActions.includes(';') ? ';' : ',').map((s) => s.trim()).filter(Boolean);
const REPLACE = args.replace !== undefined && args.replace !== 'false';
const OUT_FPS = Number(args.fps) || 12;
const OUT_FRAMES = Number(args.frames) || 24;
const OUT_SIZE = Number(args.size) || 512;
const SEED = args.seed !== undefined ? Number(args.seed) : null;
const FOLDER = args.folder || 'Characters';
const OUT_DIR = args.out || path.join('out', 'anim', NAME);
const CHROMA = '#00FF00';
const CANVAS = { width: 832, height: 480 };
const FILL = 0.62;   // sprite height as a fraction of the canvas; leaves room for limbs
const MARGIN = 0.22; // crop-back margin on each side, as a fraction of sprite size

fs.mkdirSync(OUT_DIR, { recursive: true });
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

// ── helpers ──────────────────────────────────────────────────────────────────
async function api(route, body, method = 'POST', attempt = 1) {
	let res;
	try {
		res = await fetch(`${SERVER}${route}`, {
			method,
			// 'Connection: close' + one retry: after a slow local step (ffmpeg, GIF
			// encode) the dev server has already closed the idle keep-alive socket
			// and the next large POST dies with a bare "fetch failed" (ECONNRESET).
			headers: { 'Content-Type': 'application/json', Connection: 'close' },
			body: body ? JSON.stringify(body) : undefined
		});
	} catch (err) {
		if (attempt < 3) { await new Promise((r) => setTimeout(r, 1000)); return api(route, body, method, attempt + 1); }
		throw new Error(`${route}: ${err.cause?.code || err.message}`);
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${route} ${res.status}: ${data.error || JSON.stringify(data).slice(0, 200)}`);
	return data;
}
const toDataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;
async function fetchBuffer(url) {
	const abs = url.startsWith('/') ? SERVER + url : url;
	const res = await fetch(abs);
	if (!res.ok) throw new Error(`fetch ${abs} → ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}
function buildWanPrompt(action) {
	const a = String(action || '').trim().replace(/[.\s]+$/, '');
	return `${a}. Flat solid ${CHROMA} green background, fixed camera, no zoom, character stays centered.`;
}
function actionInfo(spec) {
	// "id" or "id=custom description" (the id names the file, the text drives the model)
	const [idPart, ...rest] = spec.split('=');
	const id = idPart.trim();
	const override = rest.join('=').trim();
	const p = presetById(id);
	const text = override || (p ? p.description : id);
	const cyclic = /\b(cycle|walk|run|idle|march|sneak|sprint|channel)\b/i.test(id + ' ' + text);
	return { id: p ? p.id : id.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30), text, mode: cyclic ? 'cycle' : 'oneshot' };
}

// ── step 0: transparent source ───────────────────────────────────────────────
async function ensureCutout(imagePath) {
	const buf = fs.readFileSync(imagePath);
	const meta = await sharp(buf).metadata();
	if (meta.hasAlpha) {
		const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		let transparent = 0;
		for (let i = 3; i < data.length; i += 4) if (data[i] < 10) transparent++;
		if (transparent / (info.width * info.height) > 0.05) return buf; // already a cutout
	}
	const cached = imagePath.replace(/\.[^.]+$/, '') + '.cutout.png';
	if (fs.existsSync(cached)) { log('using cached cutout', cached); return fs.readFileSync(cached); }
	log('source has no transparency → /api/remove-background (one call)');
	const { images } = await api('/api/remove-background', { images: [toDataUrl(buf, 'image/png')] });
	if (!images?.[0]) throw new Error('remove-background returned nothing');
	const out = await fetchBuffer(images[0]);
	fs.writeFileSync(cached, out);
	return out;
}

// ── step 1: canvas prep ──────────────────────────────────────────────────────
async function prepareCanvas(cutout) {
	const trimmed = await sharp(cutout).trim().png().toBuffer();
	const m = await sharp(trimmed).metadata();
	const scale = Math.min((CANVAS.height * FILL) / m.height, (CANVAS.width * FILL) / m.width);
	const w = Math.round(m.width * scale), h = Math.round(m.height * scale);
	const x = Math.round((CANVAS.width - w) / 2), y = Math.round((CANVAS.height - h) / 2);
	const sprite = await sharp(trimmed).resize(w, h, { kernel: 'lanczos3' }).png().toBuffer();
	const canvas = await sharp({ create: { width: CANVAS.width, height: CANVAS.height, channels: 4, background: CHROMA } })
		.composite([{ input: sprite, left: x, top: y }]).png().toBuffer();
	// Crop-back rectangle = sprite box grown by MARGIN on each side, clamped to the canvas.
	const mx = Math.round(w * MARGIN), my = Math.round(h * MARGIN);
	const cx = Math.max(0, x - mx), cy = Math.max(0, y - my);
	const cw = Math.min(CANVAS.width, x + w + mx) - cx, ch = Math.min(CANVAS.height, y + h + my) - cy;
	return { canvas, crop: { x: cx, y: cy, w: cw, h: ch }, sprite: { x, y, w, h }, original: { w: m.width, h: m.height } };
}

// ── step 2–3: generate ───────────────────────────────────────────────────────
async function generate(canvasPng, prompt, seed) {
	const started = await api('/api/generate-animation', {
		referenceImage: toDataUrl(canvasPng), prompt, frameCount: 80, fps: 16, seed: seed ?? undefined, loop: true
	});
	const jobId = started.jobId;
	if (!jobId) throw new Error('no jobId');
	const t0 = Date.now();
	for (;;) {
		await new Promise((r) => setTimeout(r, 3000));
		const p = await api(`/api/generation-progress?jobId=${encodeURIComponent(jobId)}`, null, 'GET');
		if (p.status === 'completed' && p.videoUrl) return p.videoUrl;
		if (p.status === 'error') throw new Error(p.message || 'generation failed');
		if (Date.now() - t0 > 10 * 60_000) throw new Error('generation timed out');
	}
}

// ── step 4–5: frames + window ────────────────────────────────────────────────
function extractAllFrames(videoPath, dir) {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath, '-vsync', '0', path.join(dir, 'f_%04d.png')]);
	return fs.readdirSync(dir).filter((f) => f.startsWith('f_')).sort().map((f) => path.join(dir, f));
}
/**
 * Cheap per-frame analysis on a 128 px keyed thumbnail of the crop region:
 * alpha centroid (for drift), bbox size, and a small buffer for frame diffs.
 */
async function analyzeFrames(framePaths, crop) {
	const out = [];
	for (const f of framePaths) {
		const img = sharp(f);
		const m = await img.metadata();
		const sx = m.width / CANVAS.width, sy = m.height / CANVAS.height;
		const { data, info } = await img
			.extract({ left: Math.round(crop.x * sx), top: Math.round(crop.y * sy), width: Math.round(crop.w * sx), height: Math.round(crop.h * sy) })
			.resize(128, null, { kernel: 'nearest' })
			.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		keyGreen(data);
		let sum = 0, sxx = 0, syy = 0, minX = info.width, maxX = 0, minY = info.height, maxY = 0;
		for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
			const a = data[(y * info.width + x) * 4 + 3];
			if (a < 64) continue;
			sum++; sxx += x; syy += y;
			if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
		}
		const scale = crop.w / info.width; // thumbnail px → canvas px
		out.push({
			cx: sum ? (sxx / sum) * scale : crop.w / 2, cy: sum ? (syy / sum) * scale : crop.h / 2,
			w: sum ? (maxX - minX + 1) * scale : 0, h: sum ? (maxY - minY + 1) * scale : 0,
			small: data, area: sum
		});
	}
	return out;
}
function frameDiff(a, b) {
	let d = 0;
	for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]);
	return d / (a.length / 4) / 4; // mean per-channel difference, 0..255
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const std = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

/**
 * Choose which native frames become the loop.
 *   cycle   → the N consecutive frames (start ≥ 6) whose centroid and size are
 *             steadiest: image-to-video models drift sideways / zoom late in a
 *             "run in place" clip, and the steadiest stretch is the usable cycle.
 *             Each frame also gets a horizontal shift that re-centres it on the
 *             window's median centroid, which removes the remaining sway.
 *   oneshot → drop frames that barely change (the model likes to freeze on a
 *             dramatic pose for a second), then sample N evenly across the rest.
 * Returns [{ index, dx }] in canvas pixels.
 */
function pickWindow(analysis, mode, n, { minStart = 6, staticThreshold = 1.2, crop = null } = {}) {
	const total = analysis.length;
	if (mode === 'cycle') {
		if (total <= n) return analysis.map((_, i) => ({ index: i, dx: 0 }));
		let best = null;
		for (let s = Math.min(minStart, total - n); s + n <= total; s++) {
			const win = analysis.slice(s, s + n);
			const score = std(win.map((a) => a.cx)) + std(win.map((a) => a.cy)) * 0.5 + std(win.map((a) => a.h)) * 0.7
				+ Math.max(0, 5 - std(win.map((a) => a.area)) / 20); // penalise windows where nothing moves
			if (!best || score < best.score) best = { start: s, score };
		}
		const win = analysis.slice(best.start, best.start + n);
		const cx0 = median(win.map((a) => a.cx));
		return win.map((a, i) => ({ index: best.start + i, dx: a.cx - cx0 }));
	}
	// oneshot: remove static stretches, keep order. The threshold adapts to the
	// clip: a frame counts as "static" when it changed less than 35 % of the
	// clip's median frame-to-frame change (absolute floor staticThreshold), so
	// the model's habit of freezing on one dramatic pose for a second does not
	// eat a third of the loop.
	const diffs = analysis.slice(1).map((f, i) => frameDiff(f.small, analysis[i].small));
	const thr = Math.max(staticThreshold, median(diffs) * 0.5);
	const kept = [0];
	for (let i = 1; i < total; i++) {
		const prev = analysis[kept[kept.length - 1]], cur = analysis[i];
		// a held pose still flickers in texture, so also require the silhouette to move
		const moved = Math.abs(cur.cx - prev.cx) + Math.abs(cur.cy - prev.cy) + Math.abs(cur.w - prev.w) + Math.abs(cur.h - prev.h);
		if (frameDiff(cur.small, prev.small) >= thr && moved >= 0.01 * (crop?.w || 400)) kept.push(i);
	}
	if (kept.length < total) console.log(`         dropped ${total - kept.length} static frames (threshold ${thr.toFixed(1)})`);
	const usable = kept.length >= n ? kept : analysis.map((_, i) => i);
	const lo = Math.min(2, usable.length - 1), hi = usable.length - 1 - Math.min(2, usable.length - 1);
	if (usable.length <= n) return usable.map((i) => ({ index: i, dx: 0 }));
	return Array.from({ length: n }, (_, k) => ({ index: usable[Math.round(lo + ((hi - lo) * k) / (n - 1))], dx: 0 }));
}

// ── step 6–7: crop back + key ────────────────────────────────────────────────
function keyGreen(data) {
	// data: RGBA raw buffer, mutated in place
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i], g = data[i + 1], b = data[i + 2];
		const maxRB = Math.max(r, b);
		const dom = g - maxRB; // how much green exceeds the other channels
		if (g > 90 && dom > 40) {
			// soft edge: fully transparent when strongly green, partial near the edge
			const a = dom > 110 ? 0 : Math.round(255 * (1 - (dom - 40) / 70));
			data[i + 3] = Math.min(data[i + 3], a);
			if (a > 0) data[i + 1] = maxRB; // spill suppression on the fringe
		} else if (dom > 10 && g > 60) {
			data[i + 1] = Math.round(maxRB + dom * 0.4); // mild spill suppression
		}
	}
	return data;
}
async function cropAndKey(framePath, crop, outW, outH, dx = 0) {
	const img = sharp(framePath);
	const m = await img.metadata();
	const sx = m.width / CANVAS.width, sy = m.height / CANVAS.height;
	// dx re-centres a drifting frame; clamp so the crop stays inside the video.
	const left = Math.max(0, Math.min(m.width - Math.round(crop.w * sx), Math.round((crop.x + dx) * sx)));
	const { data, info } = await img
		.extract({ left, top: Math.round(crop.y * sy), width: Math.round(crop.w * sx), height: Math.round(crop.h * sy) })
		.resize(outW, outH, { kernel: 'lanczos3' })
		.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data: keyGreen(data), info };
}

// ── step 8: loop seam ────────────────────────────────────────────────────────
function blendSeam(frames) {
	const n = frames.length;
	const seam = Math.min(4, Math.max(2, Math.floor(n / 6)));
	for (let i = 0; i < seam; i++) {
		const t = (i + 1) / (seam + 1);
		const tail = frames[n - seam + i].data, head = frames[i].data;
		for (let p = 0; p < tail.length; p += 4) {
			const aT = tail[p + 3] / 255, aH = head[p + 3] / 255;
			const a = aT * (1 - t) + aH * t;
			if (a <= 0) { tail[p + 3] = 0; continue; }
			for (let c = 0; c < 3; c++) tail[p + c] = Math.round((tail[p + c] * aT * (1 - t) + head[p + c] * aH * t) / a);
			tail[p + 3] = Math.round(a * 255);
		}
	}
	return frames;
}

// ── step 9: save + index ─────────────────────────────────────────────────────
async function findFolderId(name) {
	const { items } = await api('/api/library', null, 'GET').catch(() => ({ items: [] }));
	const list = items || [];
	const hit = list.find((i) => i.isFolder && i.name.toLowerCase() === name.toLowerCase());
	if (hit) return hit.id;
	const created = await api('/api/library', { action: 'createFolder', parentId: null, name });
	return created.item?.id || created.id;
}
async function saveToLibrary(folderId, fileName, pngFrames, fps, prompt, meta) {
	const frames = pngFrames.map((b) => toDataUrl(b));
	const saved = await api('/api/save-animation', { name: fileName, frames, fps, prompt });
	if (REPLACE) {
		const { items } = await api(`/api/library?parentId=${encodeURIComponent(folderId)}`, null, 'GET');
		for (const old of (items || []).filter((i) => !i.isFolder && i.name === `${fileName}.anim.json`)) {
			await api('/api/library', { action: 'delete', id: old.id });
		}
	}
	const indexed = await api('/api/library', {
		action: 'createFile', parentId: folderId, name: `${fileName}.anim.json`, url: saved.url, fileType: 'animation',
		metadata: { thumbnailUrl: saved.thumbnailUrl, frameCount: frames.length, fps, ...meta }
	});
	return { saved, item: indexed.item };
}
function writeGif(framesDir, fps, outGif) {
	// palette pass keeps transparency crisp
	execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(framesDir, 'k_%04d.png'),
		'-vf', 'split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128', '-loop', '0', outGif]);
}

// ── main ─────────────────────────────────────────────────────────────────────
const cutout = await ensureCutout(IMAGE);
const { canvas, crop } = await prepareCanvas(cutout);
fs.writeFileSync(path.join(OUT_DIR, 'wan-input.png'), canvas);
const outW = Math.round(crop.w * (OUT_SIZE / Math.max(crop.w, crop.h)));
const outH = Math.round(crop.h * (OUT_SIZE / Math.max(crop.w, crop.h)));
const folderId = await findFolderId(FOLDER);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-anim-'));
const results = [];

for (const actionId of ACTIONS) {
	const info = actionInfo(actionId);
	const seed = SEED ?? Math.floor(Math.random() * 2_147_483_647);
	const prompt = buildWanPrompt(info.text);
	log(`▶ ${info.id} (${info.mode}) seed=${seed}`);
	try {
		const videoUrl = await generate(canvas, prompt, seed);
		const videoPath = path.join(tmp, `${info.id}.mp4`);
		fs.writeFileSync(videoPath, await fetchBuffer(videoUrl));
		const all = extractAllFrames(videoPath, path.join(tmp, info.id));
		const analysis = await analyzeFrames(all, crop);
		const chosen = pickWindow(analysis, info.mode, OUT_FRAMES, { crop });
		const first = chosen[0]?.index, last = chosen[chosen.length - 1]?.index;
		const maxShift = Math.round(Math.max(...chosen.map((c) => Math.abs(c.dx))));
		log(`  video ${all.length} native frames → ${chosen.length} frames (${info.mode}, native ${first}..${last}${info.mode === 'cycle' ? `, max re-centre ${maxShift}px` : ''})`);
		let frames = [];
		for (const c of chosen) frames.push(await cropAndKey(all[c.index], crop, outW, outH, c.dx));
		frames = blendSeam(frames);
		const keyedDir = path.join(tmp, info.id + '-keyed');
		fs.mkdirSync(keyedDir, { recursive: true });
		const pngs = [];
		for (let i = 0; i < frames.length; i++) {
			const png = await sharp(frames[i].data, { raw: frames[i].info }).png().toBuffer();
			pngs.push(png);
			fs.writeFileSync(path.join(keyedDir, `k_${String(i + 1).padStart(4, '0')}.png`), png);
		}
		const gif = path.join(OUT_DIR, `${NAME}-${info.id}.gif`);
		writeGif(keyedDir, OUT_FPS, gif);
		const { item } = await saveToLibrary(folderId, `${NAME}-${info.id}`, pngs, OUT_FPS, prompt, { seed, pose: info.id, source: 'scripts/animate.mjs' });
		log(`  ✔ saved ${item?.name} (${pngs.length} frames @ ${OUT_FPS} fps) · preview ${gif}`);
		results.push({ action: info.id, mode: info.mode, seed, frames: pngs.length, file: item?.name, gif, videoUrl });
	} catch (err) {
		log(`  ✖ ${info.id}: ${err.message}`);
		results.push({ action: info.id, error: err.message, seed });
	}
}
fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
console.log('\n' + JSON.stringify(results, null, 2));
