import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seamReport, rgbaToGrey, seamVerdict } from '../src/lib/utils/loopQuality.js';

const frame = (v) => Uint8Array.from({ length: 16 }, () => v);

test('a seam no bigger than a normal step is perfect', () => {
	// 0,10,20,30 then back to 0 is a jump of 30 vs steps of 10 → ratio 3 → broken
	const bad = seamReport([frame(0), frame(10), frame(20), frame(30)]);
	assert.equal(bad.ratio, 3);
	assert.equal(bad.verdict, 'broken');
	// 0,10,20,10 then back to 0 is a step of 10 → ratio 1 → perfect
	const good = seamReport([frame(0), frame(10), frame(20), frame(10)]);
	assert.equal(good.ratio, 1);
	assert.equal(good.verdict, 'perfect');
});

test('verdict bands', () => {
	assert.equal(seamVerdict(0.5), 'perfect');
	assert.equal(seamVerdict(1.4), 'good');
	assert.equal(seamVerdict(2.0, 5, 10), 'good'); // under the loop's own biggest step
	assert.equal(seamVerdict(2.0, 20, 10), 'visible');
	assert.equal(seamVerdict(4, 20, 10), 'broken');
});

test('transparent pixels flatten to the background instead of leaking RGB', () => {
	const g = rgbaToGrey(Uint8ClampedArray.from([255, 255, 255, 0, 255, 255, 255, 255]), 32);
	assert.equal(g[0], 32);
	assert.equal(g[1], 255);
});
