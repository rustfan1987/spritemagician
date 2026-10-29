import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-replace-test-'));
process.env.SPRITEMAGICIAN_DATA_DIR = root;
const library = await import('../src/lib/server/library.js');
const files = await import('../src/lib/server/localFiles.js');
const data = (s) => `data:image/png;base64,${Buffer.from(s).toString('base64')}`;

test('missing source preserves old bytes and library record', () => {
	const original = library.createFileFromDataUrl(null, 'missing.png', data('old'));
	assert.throws(() => library.upsertFileByName(null, 'missing.png', '/local/.uploads/missing.png'), /File not found/);
	assert.equal(fs.readFileSync(files.urlToAbs(original.url), 'utf8'), 'old');
	assert.equal(library.getItem(original.id).url, original.url);
});

test('failed index update restores original bytes and cached record', () => {
	const original = library.createFileFromDataUrl(null, 'rollback.png', data('old'));
	const source = files.saveDataUrl(data('new'), '.uploads/rollback.png');
	const rename = fs.renameSync;
	fs.renameSync = (a, b) => {
		if (String(b).endsWith(`${path.sep}db${path.sep}files.json`)) throw Object.assign(new Error('simulated index failure'), { code: 'EIO' });
		return rename(a, b);
	};
	try { assert.throws(() => library.upsertFileByName(null, 'rollback.png', source.url), /simulated index failure/); }
	finally { fs.renameSync = rename; }
	assert.equal(fs.readFileSync(files.urlToAbs(original.url), 'utf8'), 'old');
	assert.equal(fs.readFileSync(source.absPath, 'utf8'), 'new');
	assert.equal(library.getItem(original.id).url, original.url);
});

test('successful replacement keeps the item identity and installs new bytes', () => {
	const original = library.createFileFromDataUrl(null, 'success.png', data('old'));
	const source = files.saveDataUrl(data('new'), '.uploads/success.png');
	const result = library.upsertFileByName(null, 'success.png', source.url);
	assert.equal(result.item.id, original.id);
	assert.equal(result.item.url, original.url);
	assert.equal(fs.readFileSync(files.urlToAbs(original.url), 'utf8'), 'new');
	assert.equal(fs.existsSync(source.absPath), false);
});

test('an indexed source file remains available after replacement', () => {
	const original = library.createFileFromDataUrl(null, 'destination.png', data('old'));
	const source = library.createFileFromDataUrl(null, 'source.png', data('new'));
	library.upsertFileByName(null, 'destination.png', source.url);
	assert.equal(fs.readFileSync(files.urlToAbs(original.url), 'utf8'), 'new');
	assert.equal(fs.readFileSync(files.urlToAbs(source.url), 'utf8'), 'new');
	assert.equal(library.getItem(source.id).url, source.url);
});
