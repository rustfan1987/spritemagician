import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractAnimatedImageFrames } from '../src/lib/utils/animatedImageFrames.js';

const saved = { fetch: globalThis.fetch, ImageDecoder: globalThis.ImageDecoder, document: globalThis.document };
afterEach(() => Object.assign(globalThis, saved));

test('samples actual frames by duration and closes decoded images', async () => {
	const decoded = [], closed = [];
	globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
	globalThis.ImageDecoder = class {
		static async isTypeSupported() { return true; }
		tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } };
		async decode({ frameIndex }) {
			decoded.push(frameIndex);
			return { image: { duration: [100, 300][frameIndex], displayWidth: 2, displayHeight: 2, index: frameIndex, close() { closed.push(frameIndex); } } };
		}
		close() { closed.push('decoder'); }
	};
	let current;
	globalThis.document = { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage(image) { current = image.index; } }), toDataURL: () => `frame-${current}` }) };
	assert.deepEqual(await extractAnimatedImageFrames('sample.gif', 'image/gif', 4), ['frame-0', 'frame-1', 'frame-1', 'frame-1']);
	assert.deepEqual(decoded, [0, 1, 0, 1, 1, 1]);
	assert.equal(closed.length, decoded.length + 1);
	assert.equal(closed.at(-1), 'decoder');
});

test('reports unsupported decoding instead of returning duplicate still frames', async () => {
	globalThis.ImageDecoder = undefined;
	await assert.rejects(extractAnimatedImageFrames('sample.gif', 'image/gif', 4), /unavailable/);
});

test('rejects invalid counts and failed fetches', async () => {
	await assert.rejects(extractAnimatedImageFrames('sample.gif', 'image/gif', 0), /Frame count/);
	globalThis.ImageDecoder = class { static async isTypeSupported() { return true; } };
	globalThis.fetch = async () => ({ ok: false, status: 404 });
	await assert.rejects(extractAnimatedImageFrames('sample.gif', 'image/gif', 2), /404/);
});

test('closes the decoder when a frame cannot be decoded', async () => {
	let closed = false;
	globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
	globalThis.ImageDecoder = class {
		static async isTypeSupported() { return true; }
		tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 1 } };
		async decode() { throw new Error('Corrupt animation'); }
		close() { closed = true; }
	};
	await assert.rejects(extractAnimatedImageFrames('broken.webp', 'image/webp', 2), /Corrupt animation/);
	assert.equal(closed, true);
});
