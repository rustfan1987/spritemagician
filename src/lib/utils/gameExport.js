/**
 * Game-ready sprite sheet export.
 *
 *   - trims the common transparent border across all frames (so the
 *     character does not jitter between frames)
 *   - optional pixel padding between cells
 *   - optional power-of-two sheet size
 *   - emits metadata for Aseprite/TexturePacker (JSON hash), Godot 4
 *     (SpriteFrames .tres) and Unity (TexturePacker-style JSON array)
 */

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Failed to load frame'));
		img.src = src;
	});
}

function nextPow2(n) {
	let p = 1;
	while (p < n) p *= 2;
	return p;
}

/** Bounding box of non-transparent pixels, or null if fully transparent. */
function alphaBounds(ctx, w, h) {
	const { data } = ctx.getImageData(0, 0, w, h);
	let minX = w, minY = h, maxX = -1, maxY = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (data[(y * w + x) * 4 + 3] > 0) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * @param {string[]} frames   data URLs
 * @param {{name?: string, fps?: number, trim?: boolean, padding?: number, pot?: boolean, columns?: number, loop?: boolean}} opts
 * @returns {Promise<{blob: Blob, width: number, height: number, cell: {w:number,h:number}, columns: number, rows: number, frames: Array<{x:number,y:number,w:number,h:number}>, aseprite: object, godot: string, unity: object, trim: object|null}>}
 */
export async function buildGameSheet(frames, opts = {}) {
	const { name = 'sprite', fps = 12, trim = true, padding = 1, pot = true, columns: wantColumns, loop = true } = opts;
	if (!frames?.length) throw new Error('No frames to export');

	const images = await Promise.all(frames.map(loadImage));
	const srcW = images[0].naturalWidth;
	const srcH = images[0].naturalHeight;
	for (let i = 1; i < images.length; i++) {
		if (images[i].naturalWidth !== srcW || images[i].naturalHeight !== srcH) {
			throw new Error(`Frame ${i + 1} has different dimensions (${images[i].naturalWidth}×${images[i].naturalHeight}); all frames must match ${srcW}×${srcH} before game export`);
		}
	}

	// Common crop across all frames so the sprite stays anchored.
	let crop = { x: 0, y: 0, w: srcW, h: srcH };
	if (trim) {
		const scratch = document.createElement('canvas');
		scratch.width = srcW;
		scratch.height = srcH;
		const sctx = scratch.getContext('2d', { willReadFrequently: true });
		let union = null;
		for (const img of images) {
			sctx.clearRect(0, 0, srcW, srcH);
			sctx.drawImage(img, 0, 0);
			const b = alphaBounds(sctx, srcW, srcH);
			if (!b) continue;
			union = union
				? { x: Math.min(union.x, b.x), y: Math.min(union.y, b.y), x2: Math.max(union.x2, b.x + b.w), y2: Math.max(union.y2, b.y + b.h) }
				: { x: b.x, y: b.y, x2: b.x + b.w, y2: b.y + b.h };
		}
		if (union) crop = { x: union.x, y: union.y, w: union.x2 - union.x, h: union.y2 - union.y };
	}

	const cell = { w: crop.w, h: crop.h };
	const columns = Math.max(1, Math.min(wantColumns || Math.ceil(Math.sqrt(frames.length)), frames.length));
	const rows = Math.ceil(frames.length / columns);
	let width = columns * cell.w + (columns + 1) * padding;
	let height = rows * cell.h + (rows + 1) * padding;
	if (pot) {
		width = nextPow2(width);
		height = nextPow2(height);
	}

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = false;

	const rects = [];
	images.forEach((img, i) => {
		const col = i % columns;
		const row = Math.floor(i / columns);
		const x = padding + col * (cell.w + padding);
		const y = padding + row * (cell.h + padding);
		ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, x, y, cell.w, cell.h);
		rects.push({ x, y, w: cell.w, h: cell.h });
	});

	const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
	const durationMs = Math.round(1000 / Math.max(1, fps));
	const pngName = `${name}.png`;

	// Aseprite / TexturePacker "hash" format — importable by most engines and tools.
	const aseprite = {
		frames: Object.fromEntries(
			rects.map((r, i) => [
				`${name} ${i}.ase`,
				{
					frame: { x: r.x, y: r.y, w: r.w, h: r.h },
					rotated: false,
					trimmed: trim,
					spriteSourceSize: { x: crop.x, y: crop.y, w: r.w, h: r.h },
					sourceSize: { w: srcW, h: srcH },
					duration: durationMs
				}
			])
		),
		meta: {
			app: 'Sprite Magician',
			version: '1.0',
			image: pngName,
			format: 'RGBA8888',
			size: { w: width, h: height },
			scale: '1',
			frameTags: [{ name, from: 0, to: rects.length - 1, direction: 'forward' }]
		}
	};

	// Godot 4 SpriteFrames resource (text format).
	const godotLines = [
		'[gd_resource type="SpriteFrames" load_steps=' + (rects.length + 2) + ' format=3]',
		'',
		`[ext_resource type="Texture2D" path="res://${pngName}" id="1_sheet"]`,
		''
	];
	rects.forEach((r, i) => {
		godotLines.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${i}"]`);
		godotLines.push('atlas = ExtResource("1_sheet")');
		godotLines.push(`region = Rect2(${r.x}, ${r.y}, ${r.w}, ${r.h})`);
		godotLines.push('');
	});
	godotLines.push('[resource]');
	godotLines.push('animations = [{');
	godotLines.push('"frames": [' + rects.map((_, i) => `{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_${i}")\n}`).join(', ') + '],');
	godotLines.push(`"loop": ${loop ? 'true' : 'false'},`);
	godotLines.push(`"name": &"${name}",`);
	godotLines.push(`"speed": ${fps}.0`);
	godotLines.push('}]');
	const godot = godotLines.join('\n');

	// Unity: TexturePacker-style JSON array + pivot; import with any sprite-sheet importer
	// or slice manually using the rects below (Sprite Editor → Slice → Grid by cell size).
	const unity = {
		texture: pngName,
		cellSize: cell,
		padding,
		pixelsPerUnit: cell.h,
		fps,
		loop,
		sprites: rects.map((r, i) => ({ name: `${name}_${i}`, x: r.x, y: height - r.y - r.h, width: r.w, height: r.h, pivot: { x: 0.5, y: 0 } }))
	};

	return { blob, width, height, cell, columns, rows, frames: rects, aseprite, godot, unity, trim: trim ? crop : null };
}

/** Build a human-readable README for the pack. */
export function packReadme(name, sheet) {
	return [
		`${name} — exported from Sprite Magician`,
		'',
		`Sheet: ${name}.png (${sheet.width}x${sheet.height}), ${sheet.frames.length} frames, cell ${sheet.cell.w}x${sheet.cell.h}, ${sheet.columns} columns.`,
		'',
		`Aseprite / generic: ${name}.json (TexturePacker hash format).`,
		`Godot 4: copy ${name}.png and ${name}.tres into your project; use the .tres in an AnimatedSprite2D.`,
		`Unity: ${name}.unity.json lists sprite rects (Unity Y-up). In Sprite Editor choose Slice → Grid By Cell Size = cell, padding = ${sheet.frames.length ? sheet.frames[0].x : 0}.`
	].join('\n');
}
