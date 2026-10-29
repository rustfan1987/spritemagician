/**
 * Tiny JSON document store for small records
 * (jobs, rig jobs, edit clusters, config documents).
 *
 * Layout: <dataDir>/db/<collection>.json  → { [id]: doc }
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDbDir, readJson, writeJsonAtomic } from './paths.js';

const cache = new Map();

function filePath(collection) {
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(collection)) throw new Error('Bad collection name');
	return path.join(getDbDir(), `${collection}.json`);
}

function load(collection) {
	if (!cache.has(collection)) {
		cache.set(collection, readJson(filePath(collection), {}) || {});
	}
	return cache.get(collection);
}

function persist(collection) {
	writeJsonAtomic(filePath(collection), load(collection));
}

export function newId() {
	return randomUUID().replace(/-/g, '').slice(0, 20);
}

export function getDoc(collection, id) {
	const doc = load(collection)[id];
	return doc ? { id, ...doc } : null;
}

export function listDocs(collection, predicate = null) {
	const all = load(collection);
	const out = [];
	for (const [id, doc] of Object.entries(all)) {
		const item = { id, ...doc };
		if (!predicate || predicate(item)) out.push(item);
	}
	return out;
}

export function setDoc(collection, id, data, { merge = false } = {}) {
	const all = load(collection);
	const now = new Date().toISOString();
	const prev = merge ? all[id] || {} : {};
	const { id: _ignored, ...rest } = data || {};
	const previous = all[id];
	all[id] = { ...prev, ...rest, updatedAt: now, createdAt: prev.createdAt || rest.createdAt || now };
	try { persist(collection); } catch (error) {
		if (previous === undefined) delete all[id]; else all[id] = previous;
		throw error;
	}
	return { id, ...all[id] };
}

export function addDoc(collection, data) {
	const id = newId();
	return setDoc(collection, id, data);
}

export function updateDoc(collection, id, updates) {
	const all = load(collection);
	if (!all[id]) return null;
	return setDoc(collection, id, updates, { merge: true });
}

export function deleteDoc(collection, id) {
	const all = load(collection);
	if (!(id in all)) return false;
	delete all[id];
	persist(collection);
	return true;
}

export function deleteWhere(collection, predicate) {
	const all = load(collection);
	let n = 0;
	for (const [id, doc] of Object.entries(all)) {
		if (predicate({ id, ...doc })) {
			delete all[id];
			n += 1;
		}
	}
	if (n) persist(collection);
	return n;
}
