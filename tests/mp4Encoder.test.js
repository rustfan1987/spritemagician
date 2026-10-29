import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSupportedMimeType } from '../src/lib/utils/mp4Encoder.js';

const original = globalThis.MediaRecorder;
afterEach(() => { globalThis.MediaRecorder = original; });

test('selects MP4 even when WebM is supported', () => {
	globalThis.MediaRecorder = { isTypeSupported: (type) => type === 'video/mp4' || type.startsWith('video/webm') };
	assert.equal(getSupportedMimeType(), 'video/mp4');
});

test('does not label WebM as MP4 when MP4 is unavailable', () => {
	globalThis.MediaRecorder = { isTypeSupported: (type) => type.startsWith('video/webm') };
	assert.equal(getSupportedMimeType(), null);
});
