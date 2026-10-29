#!/usr/bin/env node
/**
 * scripts/animate.mjs — headless sprite → perfectly looping animations.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ NOTES FOR AI AGENTS (read this before automating animations)            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * This script reproduces what the Animate panel does in the browser, but from
 * Node, against a running Sprite Magician server (npm run dev, or the
 * Electron app). Everything below was learned by producing real batches (a
 * front-view scarecrow, then a side-scroller anime girl) and looking at every
 * frame. Keep the order; each step exists because skipping it produced a
 * visible defect.
 *
 * PIPELINE
 *   0. Source. --generate "<prompt>" makes one with FLUX schnell (≈$0.003):
 *      ask for "strict side profile facing right, neutral standing pose,
 *      whole body visible, flat solid lime green background" for side-scroller
 *      sets. Otherwise --image. A front-view sprite becomes a profile with
 *      --view side (FLUX Kontext via /api/reframe-sprite, ≈$0.04, cached as
 *      <name>.side.png; LOOK at it before trusting it). Sources without alpha
 *      go through /api/remove-background once (cached as <name>.cutout.png).
 *
 *   1. Canvas. Paint the cutout on an 832×480 chroma-green canvas (#00FF00)
 *      at 60 % of the canvas height. Wan 2.2 works at 480p 16:9; a small
 *      sprite smears, a sprite that fills the frame gets limbs cut off.
 *      Crop-back buffer = 40 % of the sprite HEIGHT on every side (height,
 *      not width: a punch from a narrow profile sprite reaches ~half a body
 *      sideways; width-relative margins clipped the fist).
 *
 *   2. Prompt (see buildWanPrompt). What the Wan 2.2 guides agree on and our
 *      tests confirmed: subject with 2–4 identifying features first → the
 *      motion as body mechanics with speed and direction, 2–3 sequential
 *      beats, ending on an explicit end state → an explicit camera line even
 *      when static ("static shot, locked camera, no zoom") → no scene/style
 *      words (the image fixes those). 25–80 words. The Replicate fast endpoint
 *      has NO negative_prompt; put constraints in the positive text. Never
 *      name props the sprite lacks (an unarmed scarecrow grew a staff from the
 *      word "weapon"). "Arms fly up, staggers" read as an attack; a hit needs
 *      "flinches, head whips back, eyes shut … does not attack".
 *
 *   3. Generate 81 frames @ 16 fps (≈5 s, ≈$0.05 on wan-2.2-i2v-fast). The
 *      endpoint also takes last_image, sample_shift (default 12) and LoRA URLs.
 *
 *   4. LOOPING — two different methods, this is the heart of it:
 *        one-shot (jump, hit, attack, cast)  → generate with last_image = the
 *            input image (loopAnchor). The clip then ends on the exact start
 *            pose, so the whole clip IS the loop: use native frames 0..79
 *            (80 ≈ 0), thin evenly to --frames (48 → 10 fps real time).
 *        cycle (walk, run, idle)              → NO anchor. Anchoring forces the
 *            clip back to the standing pose and the loop becomes
 *            walk-stand-walk. Instead search the clip for the pair of frames
 *            (i, j), 12–40 native frames apart, whose thumbnails match best
 *            (+ small bonus for longer loops, penalty for drift). Frames
 *            i..j−1 at native 16 fps are the loop. Re-centre each frame
 *            horizontally on the window's median centroid.
 *      Seam blending is only applied when the seam is still rough (unmatched
 *      windows); blending a matched loop just ghosts the legs.
 *
 *   5. Frames: extract ALL native frames with ffmpeg (-vsync 0); never let
 *      ffmpeg resample. Crop back to the buffered rectangle, resize so the
 *      longest side is --size (768), key the green locally (free, stable
 *      frame-to-frame; rembg per frame flickers and costs money).
 *
 *   6. Colour match. Unanchored clips drift lighter over 5 s (white → pink
 *      grey). One per-channel affine transform per animation (stats over all
 *      frames together, so nothing flickers) matches them to the source cutout.
 *
 *   7. Union crop ("crop around the whole animation"). Measure the opaque box
 *      of every frame of every action, take the union + --pad, and crop ALL
 *      frames of ALL actions to that one box. Nothing is ever cut off, the
 *      character does not jitter, and every action in the set shares a
 *      canvas. (UI twin: src/lib/utils/animationBounds.js, Export panel.)
 *      A "silhouette touches the crop edge" warning means the buffer in step 1
 *      was too small for that motion — fix the framing, not the frames.
 *
 *   8. Save through /api/save-animation + /api/library createFile, exactly
 *      like the UI, so the files appear in the file tree. Preview GIFs and
 *      results.json go to --out. Videos are cached under <out>/cache by
 *      (canvas, prompt, seed, anchor), so re-cropping a batch is free.
 *
 * WHAT DID NOT WORK (do not retry without new evidence)
 *   • 1024 px sprite straight into Wan — tiny, blurry.
 *   • Fill 85 % — hands clipped on the first jump. Fill 62 % + 22 % width-
 *     relative margin — fist clipped on the side attack.
 *   • Evenly sampling a 5 s walk into 24 frames — strobe.
 *   • Anchored (last_image) walk cycles — stop-and-go loops.
 *   • Seam cross-fade on matched loops — ghost legs.
 *   • Per-frame rembg — flicker, cost. Per-frame trim — jitter.
 *   • Stock "attack" preset on an unarmed character — invented weapon.
 *   • Same seed for a frozen "hit" video — identical freeze; change the SEED
 *     when the VIDEO is bad, change the pipeline when the PROCESSING is bad.
 *
 * REFERENCES (prompting): community Wan 2.2 I2V guides agree on the structure
 * above (wan27.org/blog/wan-2-2-prompt-guide, unifically.com/blogs/wan-2.2-
 * image-to-video-prompt-guide, veed.io/learn/wan-2-2-prompting-guide). A pixel
 * side-view walk LoRA for Wan 2.2 exists (civitai.com/models/2172038, trigger
 * "pix3lwalk", HF theamusing/wan2.2_pixel_walk_lora); the fast endpoint accepts
 * LoRA URLs, untested here.
 *
 * Usage:
 *   node scripts/animate.mjs --generate "full body anime girl …, strict side profile facing right, …, flat solid lime green background" \
 *        --view side --subject "an anime girl with short teal hair, a red scarf, a white jacket" \
 *        --actions side_walk,side_run,side_jump,side_hit,side_attack --name hero --seed 7 --replace
 *   node scripts/animate.mjs --image sprite.png --view side --subject "…" --actions side_walk,…   (front sprite → profile)
 *   node scripts/animate.mjs --image sprite.png --actions jump,hit,run_in_place_clean,…          (front view set)
 * Flags: --frames 48 --size 768 --pad 6 --fps N (override) --anchor false --loop window
 *        --shift 8..12 (Wan sample_shift) --reframe false --folder Characters --server URL --out DIR
 *
 * Action ids are the preset ids in src/lib/animation/presets.js. Write
 * "id=Some custom description" to keep the id for the file name but send your
 * own text to the model (separate actions with ';' if the text has commas).
 * --replace deletes an older animation of the same name before indexing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const VIEW = args.view || 'front';            // 'front' (use sprite as-is) | 'side' (reframe to profile facing right first)
const SUBJECT = args.subject || '';           // 2–4 identifying features, e.g. "a scarecrow with a jack-o'-lantern head, straw collar and red shirt"
const ANCHOR = args.anchor === undefined ? true : args.anchor !== 'false'; // last_image = input image → clip ends on the start pose
const SHIFT = args.shift !== undefined ? Number(args.shift) : undefined;   // Wan sample_shift (default 12)
const OUT_FPS = Number(args.fps) || 12;
const OUT_FRAMES = Number(args.frames) || 48;   // perfect loops: 48 of the 80 native frames → ~10 fps real-time
const OUT_SIZE = Number(args.size) || 768;      // longest side of the crop (incl. margins) before the union crop
const SEED = args.seed !== undefined ? Number(args.seed) : null;
const FOLDER = args.folder || 'Characters';
const OUT_DIR = args.out || path.join('out', 'anim', NAME);
const CHROMA = '#00FF00';
const CANVAS = { width: 832, height: 480 };
const FILL = 0.60;   // sprite height as a fraction of the canvas; leaves room for limbs
const MARGIN = 0.40; // crop-back buffer on each side, as a fraction of sprite size (jumps and swings need it)
const PAD = Number(args.pad ?? 6);                 // transparent padding around the final union crop, px
const GENERATE = args.generate || '';              // text prompt → make the source sprite with /api/text-to-image
const LOOP = args.loop || (args.anchor === 'false' ? 'window' : 'perfect'); // 'perfect' (whole anchored clip) | 'window'

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
/**
 * Prompt recipe (what the Wan 2.2 guides agree on, confirmed in our tests):
 *   1. subject with 2–4 identifying features (early tokens weigh most),
 *   2. the motion as body mechanics with speed + direction, 2–3 sequential
 *      beats so the model never freezes mid-clip, ending on an explicit end
 *      state ("back in the exact starting pose") so the last second does not drift,
 *   3. an explicit camera instruction even when static ("static shot, locked
 *      camera, no zoom") — without it Wan invents a slow push-in,
 *   4. nothing about scene/lighting/style: the image already fixes those; the
 *      only scene words we add are the flat green background we painted.
 * 25–80 words. The Replicate fast endpoint has no negative_prompt input, so
 * "do not" goes into the positive text as a constraint ("stays on the same spot").
 */
function buildWanPrompt(action, { subject = SUBJECT, view = VIEW } = {}) {
	const a = String(action || '').trim().replace(/[.\s]+$/, '');
	const who = subject ? `${subject.trim().replace(/[.\s]+$/, '')}. ` : '';
	const facing = view === 'side' && !/profile view/i.test(a) ? 'Seen in full side profile, facing right. ' : '';
	return `${who}${facing}${a}. The whole body stays inside the frame on the same spot. Static shot, locked camera, no zoom, no pan. Flat solid ${CHROMA} green background.`;
}
function actionInfo(spec) {
	// "id" or "id=custom description" (the id names the file, the text drives the model)
	const [idPart, ...rest] = spec.split('=');
	const id = idPart.trim();
	const override = rest.join('=').trim();
	const p = presetById(id);
	const text = override || (p ? p.description : id);
	const cyclic = /(^|[^a-z])(cycle|walk|walks|run|runs|idle|march|sneak|sprint|channel)([^a-z]|$)/i.test(id.replace(/_/g, ' ') + ' ' + text);
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
	// Both margins scale with HEIGHT: a punch or a swing reaches about half the
	// body height sideways, and a narrow profile sprite would otherwise get a
	// tiny side buffer (first anime attack test: fist clipped at the crop edge).
	const mx = Math.round(h * MARGIN), my = Math.round(h * MARGIN);
	const cx = Math.max(0, x - mx), cy = Math.max(0, y - my);
	const cw = Math.min(CANVAS.width, x + w + mx) - cx, ch = Math.min(CANVAS.height, y + h + my) - cy;
	return { canvas, crop: { x: cx, y: cy, w: cw, h: ch }, sprite: { x, y, w, h }, original: { w: m.width, h: m.height } };
}

// ── step 2–3: generate ───────────────────────────────────────────────────────
async function generate(canvasPng, prompt, seed, { anchor = ANCHOR } = {}) {
	// Same canvas + prompt + seed ⇒ same video. Cache it so re-cropping,
	// re-framing or re-keying a batch costs nothing.
	const cacheDir = path.join(OUT_DIR, 'cache');
	fs.mkdirSync(cacheDir, { recursive: true });
	const key = crypto.createHash('sha1').update(canvasPng).update(prompt).update(String(seed)).update(anchor ? 'A' : 'N').digest('hex').slice(0, 16);
	const cached = path.join(cacheDir, key + '.mp4');
	if (fs.existsSync(cached)) { log('  (cached video)'); return 'file://' + cached; }
	const started = await api('/api/generate-animation', {
		referenceImage: toDataUrl(canvasPng), prompt, frameCount: 80, fps: 16, seed: seed ?? undefined, loop: true,
		loopAnchor: anchor, ...(SHIFT !== undefined && { sampleShift: SHIFT })
	});
	const jobId = started.jobId;
	if (!jobId) throw new Error('no jobId');
	const t0 = Date.now();
	for (;;) {
		await new Promise((r) => setTimeout(r, 3000));
		const p = await api(`/api/generation-progress?jobId=${encodeURIComponent(jobId)}`, null, 'GET');
		if (p.status === 'completed' && p.videoUrl) {
			fs.writeFileSync(cached, await fetchBuffer(p.videoUrl));
			return 'file://' + cached;
		}
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
function pickWindow(analysis, mode, n, { minStart = 6, staticThreshold = 1.2, crop = null, loop = LOOP } = {}) {
	const total = analysis.length;
	if (loop === 'perfect' && mode === 'cycle') {
		// PERFECT CYCLE: search the clip for the pair (i, j) whose frames match
		// best, with j − i between minLen and maxLen native frames (a stride or
		// two). Frames i..j−1 are the loop; j is the same pose as i so it is
		// dropped. Score = pixel diff + small bonus for longer loops + penalty
		// for windows that drift. Native 16 fps is kept (no thinning).
		const minLen = 12, maxLen = Math.min(40, total - 2);
		let best = null;
		for (let i = 2; i + minLen < total; i++) {
			for (let j = i + minLen; j <= Math.min(total - 1, i + maxLen); j++) {
				const win = analysis.slice(i, j);
				const seam = frameDiff(analysis[i].small, analysis[j].small);
				const drift = std(win.map((a) => a.cx)) * 0.05 + std(win.map((a) => a.h)) * 0.05;
				const score = seam - (j - i) * 0.03 + drift;
				if (!best || score < best.score) best = { i, j, score, seam };
			}
		}
		const idx = Array.from({ length: best.j - best.i }, (_, k) => best.i + k);
		const cx0 = median(idx.map((i) => analysis[i].cx));
		console.log(`         cycle loop: native ${best.i}..${best.j - 1} (${idx.length} frames), seam diff ${best.seam.toFixed(1)}`);
		return idx.map((i) => ({ index: i, dx: analysis[i].cx - cx0, native: true }));
	}
	if (loop === 'perfect') {
		// PERFECT ONE-SHOT: the clip was generated with last_image = input image, so
		// native frame 80 ≈ frame 0. Use the whole clip minus that duplicate last
		// frame; thin evenly to n (frame 0 always kept) and let the caller derive
		// the playback fps from the thinning ratio so real-time speed is kept.
		// Re-centre each frame horizontally on the median centroid (drift kills a
		// loop faster than anything else).
		const usable = total - 1;
		const idx = usable <= n ? Array.from({ length: usable }, (_, i) => i)
			: Array.from({ length: n }, (_, k) => Math.round((usable * k) / n));
		const cx0 = median(idx.map((i) => analysis[i].cx));
		return idx.map((i) => ({ index: i, dx: mode === 'cycle' ? analysis[i].cx - cx0 : 0 }));
	}
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

// ── colour match to the source sprite ───────────────────────────────────────
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

// ── step 8: loop seam ────────────────────────────────────────────────────────
function blendSeam(frames) {
	const n = frames.length;
	const seam = 2; // loops are already matched; 2 blended frames hide residual jitter without smearing
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

// ── union crop ("crop around the whole animation") ──────────────────────────
/** Alpha bounding box of one RGBA raw frame (threshold 16). */
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

// ── main ─────────────────────────────────────────────────────────────────────
let IMAGE_PATH = IMAGE;
if (GENERATE) {
	// Make the example character ourselves (FLUX schnell, ≈$0.003) so the
	// pipeline never depends on finding a licence-free sprite online.
	const genPath = path.join(OUT_DIR, `${NAME}.source.png`);
	if (!fs.existsSync(genPath)) {
		log('generating source sprite via /api/text-to-image');
		const { url } = await api('/api/text-to-image', { prompt: GENERATE, seed: SEED ?? undefined, aspectRatio: '1:1' });
		fs.writeFileSync(genPath, await fetchBuffer(url));
	} else log('using cached generated sprite', genPath);
	IMAGE_PATH = genPath;
}
let source = await ensureCutout(IMAGE_PATH);
if (VIEW === 'side' && !GENERATE && args.reframe !== 'false') { // --reframe false when the sprite is already a profile
	// Side-scroller sets need a profile sprite. /api/reframe-sprite (FLUX Kontext,
	// ≈$0.04) redraws the character facing right; cached as <name>.side.png so
	// re-runs are free. Look at that file before trusting a batch to it.
	const sidePath = IMAGE_PATH.replace(/\.[^.]+$/, '') + '.side.png';
	if (!fs.existsSync(sidePath)) {
		log('reframing sprite to side profile (facing right) via /api/reframe-sprite');
		const { url } = await api('/api/reframe-sprite', { image: toDataUrl(source), view: 'side' });
		fs.writeFileSync(sidePath, await fetchBuffer(url));
	} else log('using cached side view', sidePath);
	source = await ensureCutout(sidePath);
}
const cutout = source;
const sourceStats = rgbStats([(await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true })).data]);
const { canvas, crop } = await prepareCanvas(cutout);
fs.writeFileSync(path.join(OUT_DIR, 'wan-input.png'), canvas);
const outW = Math.round(crop.w * (OUT_SIZE / Math.max(crop.w, crop.h)));
const outH = Math.round(crop.h * (OUT_SIZE / Math.max(crop.w, crop.h)));
const folderId = await findFolderId(FOLDER);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-anim-'));
const results = [];
const done = []; // phase-1 output per action, cropped in phase 2

// Phase 1: generate, key, measure. Nothing is saved yet so every action can
// be cropped to the SAME box in phase 2 (a character set must share a canvas).
for (const actionId of ACTIONS) {
	const info = actionInfo(actionId);
	if (VIEW === 'side' && presetById(info.id) && !presetById(info.id).side) log(`  note: ${info.id} is a front-view preset; side_* presets fit a profile sprite better`);
	const seed = SEED ?? Math.floor(Math.random() * 2_147_483_647);
	const prompt = buildWanPrompt(info.text);
	log(`▶ ${info.id} (${info.mode}, ${LOOP} loop) seed=${seed}`);
	try {
		// Cycles are NOT anchored: last_image = input forces the clip back to the
		// standing pose, and a walk that stops to stand at every loop is not a
		// loop. For cycles we instead find two frames one stride apart that match.
		const videoUrl = await generate(canvas, prompt, seed, { anchor: info.mode !== 'cycle' && ANCHOR });
		const videoPath = path.join(tmp, `${info.id}.mp4`);
		fs.copyFileSync(videoUrl.slice('file://'.length), videoPath);
		const all = extractAllFrames(videoPath, path.join(tmp, info.id));
		const analysis = await analyzeFrames(all, crop);
		const chosen = pickWindow(analysis, info.mode, OUT_FRAMES, { crop });
		const fps = args.fps ? OUT_FPS : chosen[0]?.native ? 16 : (LOOP === 'perfect' ? Math.max(6, Math.round((16 * chosen.length) / (all.length - 1))) : OUT_FPS);
		const first = chosen[0]?.index, last = chosen[chosen.length - 1]?.index;
		const maxShift = Math.round(Math.max(...chosen.map((c) => Math.abs(c.dx))));
		const seamDiff = frameDiff(analysis[chosen[chosen.length - 1].index].small, analysis[chosen[0].index].small).toFixed(1);
		log(`  video ${all.length} native frames → ${chosen.length} frames @ ${fps} fps (native ${first}..${last}, re-centre ≤${maxShift}px, last≈first diff ${seamDiff})`);
		let frames = [];
		for (const c of chosen) frames.push(await cropAndKey(all[c.index], crop, outW, outH, c.dx));
		// Blend the seam only when the loop is not already matched: blending a
		// matched cycle just ghosts the legs for two frames.
		if (!chosen[0]?.native && Number(seamDiff) > 3) frames = blendSeam(frames);
		// Colour drift: unanchored clips (cycles) slowly wash out — the white
		// jacket went pink-grey by frame 40. Match every frame of the animation
		// to the source cutout with ONE per-channel affine transform (stats over
		// all frames together, so nothing flickers).
		colorMatch(frames, sourceStats);
		const box = unionBox(frames.map(alphaBox));
		const keyedDir = path.join(tmp, info.id + '-keyed');
		fs.mkdirSync(keyedDir, { recursive: true });
		for (let i = 0; i < frames.length; i++) {
			fs.writeFileSync(path.join(keyedDir, `k_${String(i + 1).padStart(4, '0')}.png`), await sharp(frames[i].data, { raw: frames[i].info }).png().toBuffer());
		}
		const touchesEdge = box && (box.x0 === 0 || box.y0 === 0 || box.x1 === outW || box.y1 === outH);
		if (touchesEdge) log(`  ⚠ silhouette touches the crop edge in some frame — raise MARGIN or lower FILL and re-run`);
		done.push({ info, seed, prompt, keyedDir, count: frames.length, fps, box, videoUrl });
	} catch (err) {
		log(`  ✖ ${info.id}: ${err.message}`);
		results.push({ action: info.id, error: err.message, seed });
	}
}

// Phase 2: one crop box for the whole set (union of every frame of every
// action, plus PAD), applied identically so all actions share a canvas and
// nothing is ever cut off. This is the "crop around the whole animation" tool;
// the UI has the same thing in src/lib/utils/animationBounds.js.
const setBox = unionBox(done.map((d) => d.box));
if (setBox) {
	const bx = Math.max(0, setBox.x0 - PAD), by = Math.max(0, setBox.y0 - PAD);
	const bw = Math.min(outW, setBox.x1 + PAD) - bx, bh = Math.min(outH, setBox.y1 + PAD) - by;
	log(`crop box for the set: ${bw}×${bh} at (${bx},${by}) of ${outW}×${outH}`);
	for (const d of done) {
		const croppedDir = d.keyedDir + '-crop';
		fs.mkdirSync(croppedDir, { recursive: true });
		const pngs = [];
		for (let i = 1; i <= d.count; i++) {
			const name = `k_${String(i).padStart(4, '0')}.png`;
			const png = await sharp(path.join(d.keyedDir, name)).extract({ left: bx, top: by, width: bw, height: bh }).png().toBuffer();
			fs.writeFileSync(path.join(croppedDir, name), png);
			pngs.push(png);
		}
		const gif = path.join(OUT_DIR, `${NAME}-${d.info.id}.gif`);
		writeGif(croppedDir, d.fps, gif);
		try {
			const { item } = await saveToLibrary(folderId, `${NAME}-${d.info.id}`, pngs, d.fps, d.prompt, { seed: d.seed, pose: d.info.id, loop: LOOP, source: 'scripts/animate.mjs' });
			log(`  ✔ saved ${item?.name} (${pngs.length} frames @ ${d.fps} fps, ${bw}×${bh}) · preview ${gif}`);
			results.push({ action: d.info.id, mode: d.info.mode, seed: d.seed, frames: pngs.length, fps: d.fps, size: `${bw}x${bh}`, file: item?.name, gif, videoUrl: d.videoUrl });
		} catch (err) {
			log(`  ✖ save ${d.info.id}: ${err.message}`);
			results.push({ action: d.info.id, error: err.message, seed: d.seed, gif });
		}
	}
}
fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
console.log('\n' + JSON.stringify(results, null, 2));
