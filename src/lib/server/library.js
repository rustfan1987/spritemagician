/**
 * The user's asset library: a folder tree on disk plus a JSON index.
 *
 * Items live in <dataDir>/db/files.json and mirror real folders and files
 * under <dataDir>/library, so the tree you see in the app is the tree you
 * see in Explorer / Finder. Each item records its on-disk `relPath`, and
 * rescanLibrary() reconciles the index with whatever is on disk.
 *
 * Item shape:
 *   { id, name, parentId, isFolder, url, thumbnailUrl, fileType,
 *     metadata, size, relPath, createdAt, updatedAt }
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from './db.js';
import {
	relPathToAbs,
	relPathToUrl,
	saveDataUrl,
	saveBuffer,
	urlToAbs,
	urlToRelPath,
	sanitizeRelPath,
	deleteLocalUrl,
	uniqueFileName,
	isLocalUrl,
	MIME_BY_EXT
} from './localFiles.js';
import { getLibraryDir } from './paths.js';

const COL = 'files';
const THUMB_DIR = '.thumbs';
export const DEFAULT_FOLDERS = ['Characters', 'Creatures', 'Items', 'Scenery', 'Effects', 'Props'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'webm']);
const MODEL_EXTS = new Set(['glb', 'gltf', 'fbx', 'obj']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sortItems(items) {
	return items.sort((a, b) => {
		if (a.isFolder && !b.isFolder) return -1;
		if (!a.isFolder && b.isFolder) return 1;
		return (a.name || '').localeCompare(b.name || '');
	});
}

/** Make a name safe for every OS: strip illegal chars, trailing dots/spaces, reserved names. */
export function safeName(name) {
	let cleaned = String(name || '')
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
		.replace(/[. ]+$/g, '')
		.slice(0, 120);
	if (!cleaned) cleaned = 'untitled';
	if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
	return cleaned;
}

function fileTypeForName(name) {
	const ext = path.extname(name).slice(1).toLowerCase();
	if (name.endsWith('.anim.json')) return 'animation';
	if (IMAGE_EXTS.has(ext)) return 'image';
	if (VIDEO_EXTS.has(ext)) return 'video';
	if (MODEL_EXTS.has(ext)) return 'model';
	return 'file';
}

function sameFile(a, b) {
	return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// ── Paths ───────────────────────────────────────────────────────────────

/** Relative on-disk path of an item. Prefers the stored relPath; falls back to names. */
export function itemRelPath(item) {
	if (!item) return '';
	if (typeof item.relPath === 'string') return item.relPath;
	const segments = [];
	let current = item;
	let guard = 0;
	while (current && guard++ < 64) {
		segments.unshift(safeName(current.name));
		current = current.parentId ? db.getDoc(COL, current.parentId) : null;
	}
	return segments.join('/');
}

export function folderRelPath(folderId) {
	if (!folderId) return '';
	return itemRelPath(db.getDoc(COL, folderId));
}

function joinRel(dir, name) {
	return dir ? `${dir}/${name}` : name;
}

// ── Reads ───────────────────────────────────────────────────────────────

export function getItem(id) {
	return db.getDoc(COL, id);
}

export function getChildren(parentId = null) {
	return sortItems(db.listDocs(COL, (i) => (i.parentId || null) === (parentId || null)));
}

export function listAll() {
	return db.listDocs(COL);
}

export function ensureDefaultFolders() {
	if (getChildren(null).length > 0) return;
	for (const name of DEFAULT_FOLDERS) createFolder(null, name);
}

// ── Writes ──────────────────────────────────────────────────────────────

export function createFolder(parentId, name, metadata = {}) {
	const folderName = safeName(name);
	const rel = joinRel(folderRelPath(parentId), folderName);
	fs.mkdirSync(relPathToAbs(rel), { recursive: true });
	const existing = db.listDocs(COL, (i) => i.isFolder && (i.parentId || null) === (parentId || null) && i.name === folderName)[0];
	if (existing) return existing;
	return db.addDoc(COL, {
		name: folderName,
		parentId: parentId || null,
		isFolder: true,
		url: null,
		thumbnailUrl: null,
		fileType: null,
		metadata: metadata || {},
		size: null,
		relPath: rel
	});
}

function indexFile(parentId, rel, fileType, metadata, thumbnailUrl) {
	const abs = relPathToAbs(rel);
	const size = fs.existsSync(abs) ? fs.statSync(abs).size : null;
	return db.addDoc(COL, {
		name: path.basename(rel),
		parentId: parentId || null,
		isFolder: false,
		url: relPathToUrl(rel),
		thumbnailUrl: thumbnailUrl || null,
		fileType: fileType || fileTypeForName(rel),
		metadata: metadata || {},
		size,
		relPath: rel
	});
}

/** Store a file inside a folder from a data URL and index it. */
export function createFileFromDataUrl(parentId, name, dataUrl, fileType = 'image', metadata = {}) {
	const { thumbnailUrl, thumbnailData, ...rest } = metadata || {};
	const rel = joinRel(folderRelPath(parentId), safeName(name));
	const saved = saveDataUrl(dataUrl, rel);
	const thumb = thumbnailData ? saveThumbnail(thumbnailData) : thumbnailUrl || null;
	return indexFile(parentId, saved.relPath, fileType, rest, thumb);
}

/**
 * Index a file that already exists at a /local URL (e.g. produced by a route).
 * If the file lives outside the target folder it is moved in.
 */
export function createFileFromUrl(parentId, name, url, fileType = 'image', metadata = {}) {
	const { thumbnailUrl, size, ...rest } = metadata || {};
	let finalName = safeName(name);

	if (!isLocalUrl(url)) {
		return db.addDoc(COL, {
			name: finalName,
			parentId: parentId || null,
			isFolder: false,
			url,
			thumbnailUrl: thumbnailUrl || null,
			fileType,
			metadata: rest,
			size: size || null,
			relPath: null
		});
	}

	const abs = urlToAbs(url);
	if (!abs || !fs.existsSync(abs)) throw new Error(`File not found: ${url}`);
	const targetDirRel = folderRelPath(parentId);
	const targetDirAbs = relPathToAbs(targetDirRel || '.');
	fs.mkdirSync(targetDirAbs, { recursive: true });
	if (!path.extname(finalName)) finalName += path.extname(abs);
	const expectedAbs = path.join(targetDirAbs, finalName);
	if (!sameFile(abs, expectedAbs)) {
		finalName = uniqueFileName(targetDirAbs, finalName);
		fs.renameSync(abs, path.join(targetDirAbs, finalName));
	}
	return indexFile(parentId, joinRel(targetDirRel, finalName), fileType, rest, thumbnailUrl);
}

/** Upsert by (parentId + name). Returns { item, replaced }. */
export function upsertFileByName(parentId, name, url, fileType = 'image', metadata = {}) {
	const wanted = safeName(name);
	const existing = db.listDocs(
		COL,
		(i) => !i.isFolder && (i.parentId || null) === (parentId || null) && i.name === wanted
	)[0];
	if (!existing) return { item: createFileFromUrl(parentId, name, url, fileType, metadata), replaced: false };

	const { thumbnailUrl, size, ...rest } = metadata || {};
	const oldPath = existing.url && isLocalUrl(existing.url) ? urlToAbs(existing.url) : null;
	if (!isLocalUrl(url)) {
		const item = db.setDoc(COL, existing.id, { name: wanted, parentId: parentId || null, isFolder: false, url, thumbnailUrl: thumbnailUrl || null, fileType, metadata: rest, size: size || null, relPath: null }, { merge: true });
		if (existing.url && existing.url !== url) deleteLocalUrl(existing.url);
		if (existing.thumbnailUrl && existing.thumbnailUrl !== item.thumbnailUrl) deleteLocalUrl(existing.thumbnailUrl);
		return { item, replaced: true };
	}
	const incoming = urlToAbs(url);
	if (!incoming || !fs.existsSync(incoming) || !fs.statSync(incoming).isFile()) throw new Error(`File not found: ${url}`);
	const rel = joinRel(folderRelPath(parentId), wanted);
	const target = relPathToAbs(rel);
	if (fs.existsSync(target) && (!oldPath || !sameFile(target, oldPath)) && !sameFile(target, incoming)) {
		throw new Error('A different file already occupies the replacement path');
	}
	const token = randomUUID();
	const stage = path.join(path.dirname(target), `.replacement-${token}.tmp`);
	const backup = path.join(path.dirname(target), `.replacement-backup-${token}-${path.basename(target)}`);
	let backedUp = false, installed = false;
	try {
		if (!sameFile(incoming, target)) {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(incoming, stage, fs.constants.COPYFILE_EXCL);
			if (fs.existsSync(target)) { fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL); backedUp = true; }
			fs.renameSync(stage, target);
			installed = true;
		}
		const item = db.setDoc(COL, existing.id, { name: wanted, parentId: parentId || null, isFolder: false, url: relPathToUrl(rel), thumbnailUrl: thumbnailUrl || null, fileType, metadata: rest, size: fs.statSync(target).size, relPath: rel }, { merge: true });
		if (backedUp) { try { fs.unlinkSync(backup); } catch {} }
		if (oldPath && !sameFile(oldPath, target)) deleteLocalUrl(existing.url);
		if (!sameFile(incoming, target) && !db.listDocs(COL, (entry) => entry.url === url).length) deleteLocalUrl(url);
		if (existing.thumbnailUrl && existing.thumbnailUrl !== item.thumbnailUrl) deleteLocalUrl(existing.thumbnailUrl);
		return { item, replaced: true };
	} catch (error) {
		if (installed) {
			try { if (backedUp) fs.renameSync(backup, target); else fs.unlinkSync(target); }
			catch (restoreError) { throw new Error(`Replacement failed: ${error.message}. Original backup retained at ${backup}; restore failed: ${restoreError.message}`); }
		}
		throw error;
	} finally {
		try { if (fs.existsSync(stage)) fs.unlinkSync(stage); } catch {}
		if (!installed && backedUp) { try { fs.unlinkSync(backup); } catch {} }
	}
}

export function updateItem(id, updates) {
	const item = db.getDoc(COL, id);
	if (!item) return null;
	const patch = {};
	if (updates.metadata && typeof updates.metadata === 'object') {
		patch.metadata = { ...(item.metadata || {}), ...updates.metadata };
	}
	if (typeof updates.url === 'string') patch.url = updates.url.split('?')[0];
	if (typeof updates.thumbnailUrl === 'string' || updates.thumbnailUrl === null) {
		patch.thumbnailUrl = updates.thumbnailUrl;
	}
	if (typeof updates.fileType === 'string') patch.fileType = updates.fileType;
	if (Number.isFinite(updates.size)) patch.size = updates.size;
	return db.setDoc(COL, id, patch, { merge: true });
}

export function renameItem(id, newName) {
	const item = db.getDoc(COL, id);
	if (!item) return null;
	let name = safeName(newName);
	// Keep the original extension unless the user typed one.
	if (!item.isFolder && !path.extname(name) && path.extname(item.name)) name += path.extname(item.name);
	if (name === item.name) return item;

	const parentRel = folderRelPath(item.parentId);
	const fromRel = itemRelPath(item);
	const toRel = joinRel(parentRel, name);
	const fromAbs = relPathToAbs(fromRel);
	const toAbs = relPathToAbs(toRel);
	if (fs.existsSync(fromAbs)) {
		if (fs.existsSync(toAbs) && !sameFile(fromAbs, toAbs)) {
			throw new Error('A file or folder with that name already exists');
		}
		fs.renameSync(fromAbs, toAbs);
	}
	const patch = { name, relPath: toRel };
	if (!item.isFolder) patch.url = relPathToUrl(toRel);
	const updated = db.setDoc(COL, id, patch, { merge: true });
	if (item.isFolder) refreshPathsUnder(id);
	return updated;
}

export function moveItem(id, newParentId) {
	const item = db.getDoc(COL, id);
	if (!item) return null;
	if ((item.parentId || null) === (newParentId || null)) return item;
	if (item.isFolder && isDescendant(newParentId, id)) throw new Error('Cannot move a folder into itself');

	const fromRel = itemRelPath(item);
	const toParentRel = folderRelPath(newParentId);
	const toDirAbs = relPathToAbs(toParentRel || '.');
	fs.mkdirSync(toDirAbs, { recursive: true });
	const name = uniqueFileName(toDirAbs, item.name);
	const toRel = joinRel(toParentRel, name);
	const fromAbs = relPathToAbs(fromRel);
	if (fs.existsSync(fromAbs)) fs.renameSync(fromAbs, relPathToAbs(toRel));

	const patch = { parentId: newParentId || null, name, relPath: toRel };
	if (!item.isFolder) patch.url = relPathToUrl(toRel);
	const updated = db.setDoc(COL, id, patch, { merge: true });
	if (item.isFolder) refreshPathsUnder(id);
	return updated;
}

function isDescendant(candidateId, ancestorId) {
	let cur = candidateId ? db.getDoc(COL, candidateId) : null;
	let guard = 0;
	while (cur && guard++ < 64) {
		if (cur.id === ancestorId) return true;
		cur = cur.parentId ? db.getDoc(COL, cur.parentId) : null;
	}
	return false;
}

function refreshPathsUnder(folderId) {
	const rel = folderRelPath(folderId);
	for (const child of getChildren(folderId)) {
		const childRel = joinRel(rel, child.name);
		const patch = { relPath: childRel };
		if (!child.isFolder) patch.url = relPathToUrl(childRel);
		db.setDoc(COL, child.id, patch, { merge: true });
		if (child.isFolder) refreshPathsUnder(child.id);
	}
}

export function deleteItem(id) {
	const item = db.getDoc(COL, id);
	if (!item) return false;
	if (item.isFolder) {
		for (const child of getChildren(id)) deleteItem(child.id);
		const rel = itemRelPath(item);
		try {
			const abs = relPathToAbs(rel);
			if (rel && fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
		} catch (err) {
			console.warn('[library] folder delete failed:', err?.message);
		}
	} else {
		if (item.url) deleteLocalUrl(item.url);
		if (item.thumbnailUrl) deleteLocalUrl(item.thumbnailUrl);
	}
	return db.deleteDoc(COL, id);
}

/** Overwrite the bytes of an existing library file in place. */
export function replaceFileContents(url, dataUrl) {
	const rel = urlToRelPath(url);
	if (!rel) throw new Error('Not a local library URL');
	const saved = saveDataUrl(dataUrl, rel, { overwrite: true });
	const item = db.listDocs(COL, (i) => i.url === url.split('?')[0])[0];
	if (item) {
		// The thumbnail no longer matches the new bytes.
		if (item.thumbnailUrl) deleteLocalUrl(item.thumbnailUrl);
		db.setDoc(COL, item.id, { size: saved.size, thumbnailUrl: null }, { merge: true });
	}
	return saved;
}

export function saveThumbnail(dataUrl) {
	return saveDataUrl(dataUrl, `${THUMB_DIR}/${db.newId()}`).url;
}

/** Absolute path of an item on disk (for "reveal in folder"). */
export function absolutePathOf(id) {
	const item = db.getDoc(COL, id);
	if (!item) return null;
	const rel = itemRelPath(item);
	return rel ? relPathToAbs(rel) : getLibraryDir();
}

// ── Reconcile with disk ─────────────────────────────────────────────────

/**
 * Walk the library folder and make the index match it:
 *  - files/folders added outside the app get indexed
 *  - index entries whose file vanished are removed
 * Dot-folders (.thumbs, .projects, …) are internal and skipped.
 * @returns {{added: number, removed: number}}
 */
export function rescanLibrary() {
	const root = getLibraryDir();
	const all = db.listDocs(COL);
	const byRel = new Map();
	for (const item of all) {
		const rel = itemRelPath(item);
		if (rel) byRel.set(rel.toLowerCase(), item);
	}

	let added = 0;
	let removed = 0;

	// Remove entries whose file is gone.
	for (const item of all) {
		if (!item.relPath && !item.url?.startsWith('/local/')) continue; // remote URL entries stay
		const rel = itemRelPath(item);
		if (rel && !fs.existsSync(relPathToAbs(rel))) {
			db.deleteDoc(COL, item.id);
			byRel.delete(rel.toLowerCase());
			removed += 1;
		}
	}

	// Add anything on disk that is not indexed.
	const walk = (dirRel, parentId) => {
		let entries;
		try {
			entries = fs.readdirSync(relPathToAbs(dirRel || '.'), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const rel = joinRel(dirRel, entry.name);
			let item = byRel.get(rel.toLowerCase());
			if (entry.isDirectory()) {
				if (!item) {
					item = db.addDoc(COL, {
						name: entry.name,
						parentId,
						isFolder: true,
						url: null,
						thumbnailUrl: null,
						fileType: null,
						metadata: {},
						size: null,
						relPath: rel
					});
					byRel.set(rel.toLowerCase(), item);
					added += 1;
				}
				walk(rel, item.id);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).slice(1).toLowerCase();
				if (!MIME_BY_EXT[ext]) continue;
				if (!item) {
					indexFile(parentId, rel, fileTypeForName(entry.name), { source: 'rescan' }, null);
					added += 1;
				}
			}
		}
	};
	walk('', null);

	if (added || removed) console.log(`[library] rescan: +${added} / -${removed}`);
	return { added, removed };
}

export { getLibraryDir, sanitizeRelPath, saveBuffer };
