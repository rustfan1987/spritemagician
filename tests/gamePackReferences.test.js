import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relinkGameSheet } from '../src/lib/utils/gameExport.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-pack-test-'));
process.env.SPRITEMAGICIAN_DATA_DIR = root;
const library = await import('../src/lib/server/library.js');
const files = await import('../src/lib/server/localFiles.js');
const template = () => ({ aseprite: { meta: { image: 'sprite.png' } }, unity: { texture: 'sprite.png' }, godot: '[ext_resource type="Texture2D" path="res://sprite.png" id="1_sheet"]' });

test('repeated saves link each metadata file to its own actual sheet', () => {
	const folder = library.createFolder(null, 'Study');
	function save(content) {
		const uploaded = files.saveDataUrl(`data:image/png;base64,${Buffer.from(content).toString('base64')}`, 'Study/sprite.png');
		const item = library.createFileFromUrl(folder.id, 'sprite.png', uploaded.url, 'image');
		const sheet = relinkGameSheet(template(), library.getItem(item.id).name);
		const json = `data:application/json;base64,${Buffer.from(JSON.stringify(sheet.aseprite)).toString('base64')}`;
		const metadata = library.createFileFromDataUrl(folder.id, 'sprite.json', json, 'file');
		return { item, metadata: JSON.parse(fs.readFileSync(files.urlToAbs(metadata.url), 'utf8')), sheet };
	}
	const first = save('first'), second = save('second');
	assert.notEqual(first.item.name, second.item.name);
	for (const result of [first, second]) {
		assert.equal(result.metadata.meta.image, result.item.name);
		assert.equal(result.sheet.unity.texture, result.item.name);
		assert.ok(result.sheet.godot.includes(`path="res://${result.item.name}"`));
	}
	assert.equal(fs.readFileSync(files.urlToAbs(second.item.url), 'utf8'), 'second');
});

test('refuses inconsistent metadata or unsafe names', () => {
	assert.throws(() => relinkGameSheet(template(), '../bad.png'), /invalid filename/);
	const sheet = template(); sheet.unity.texture = 'other.png';
	assert.throws(() => relinkGameSheet(sheet, 'sprite (2).png'), /inconsistent/);
});
