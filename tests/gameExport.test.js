import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildGameSheet } from '../src/lib/utils/gameExport.js';

const original = { Image: globalThis.Image, document: globalThis.document };
afterEach(() => Object.assign(globalThis, original));

function installImages(fixtures) {
	globalThis.Image = class {
		set src(value) { Object.assign(this, fixtures[value]); queueMicrotask(() => this.onload()); }
	};
	globalThis.document = { createElement: () => {
		let image;
		return {
			getContext: () => ({ clearRect() {}, drawImage(value) { image = value; }, getImageData() { return { data: image.pixels }; } }),
			toBlob(callback) { callback(new Blob(['png'])); }
		};
	} };
}

test('rejects differently sized frames before they can be clipped', async () => {
	installImages({ a: { naturalWidth: 4, naturalHeight: 4 }, b: { naturalWidth: 8, naturalHeight: 4 } });
	await assert.rejects(buildGameSheet(['a', 'b']), /Frame 2 has different dimensions/);
});

test('trim retains faint nonzero-alpha pixels', async () => {
	const pixels = new Uint8ClampedArray(4 * 4 * 4);
	pixels[(1 * 4 + 1) * 4 + 3] = 255;
	pixels[(1 * 4 + 3) * 4 + 3] = 1;
	installImages({ a: { naturalWidth: 4, naturalHeight: 4, pixels } });
	const result = await buildGameSheet(['a'], { padding: 0, pot: false });
	assert.deepEqual(result.trim, { x: 1, y: 1, w: 3, h: 1 });
});
