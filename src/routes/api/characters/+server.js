/**
 * Character sets: one reference image + locked style + a list of actions.
 *
 * GET    /api/characters            → { characters }
 * POST   /api/characters            { action: 'create'|'update'|'delete'|'setAction', ... }
 */
import { json } from '@sveltejs/kit';
import * as db from '$lib/server/db.js';
import { createFolder, getChildren } from '$lib/server/library.js';

const COL = 'characters';

function sanitize(c) {
	return {
		name: String(c.name || 'Character').trim().slice(0, 80),
		referenceUrl: typeof c.referenceUrl === 'string' ? c.referenceUrl : null,
		referenceFileId: c.referenceFileId || null,
		folderId: c.folderId || null,
		seed: Number.isFinite(Number(c.seed)) ? Number(c.seed) : Math.floor(Math.random() * 2_147_483_647),
		style: {
			pixelate: !!c.style?.pixelate,
			pixelSize: Math.max(1, Math.min(32, Number(c.style?.pixelSize) || 4)),
			colorLevels: Math.max(2, Math.min(64, Number(c.style?.colorLevels) || 8)),
			removeBackground: c.style?.removeBackground !== false,
			canvasPadding: Math.max(0, Math.min(512, Number(c.style?.canvasPadding) || 0)),
			fps: Math.max(4, Math.min(24, Number(c.style?.fps) || 12)),
			duration: Math.max(1, Math.min(10, Number(c.style?.duration) || 3)),
			loopMode: ['none', 'pingpong', 'perfect'].includes(c.style?.loopMode) ? c.style.loopMode : 'perfect',
			subject: String(c.style?.subject || '').slice(0, 300),
			view: c.style?.view === 'side' ? 'side' : 'front',
			reframe: c.style?.reframe !== false
		},
		actions: Array.isArray(c.actions) ? c.actions.slice(0, 40) : []
	};
}

export async function GET() {
	return json({ characters: db.listDocs(COL).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) });
}

export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const action = String(body?.action || '');
	try {
		switch (action) {
			case 'create': {
				const data = sanitize(body.character || {});
				// Give every character its own folder under Characters/.
				const charactersRoot = getChildren(null).find((i) => i.isFolder && i.name === 'Characters') || createFolder(null, 'Characters');
				const folder = createFolder(charactersRoot.id, data.name, { source: 'character' });
				const character = db.addDoc(COL, { ...data, folderId: folder.id });
				return json({ character });
			}
			case 'update': {
				const existing = db.getDoc(COL, String(body.id));
				if (!existing) return json({ error: 'Not found' }, { status: 404 });
				const data = sanitize({ ...existing, ...(body.character || {}), style: { ...existing.style, ...(body.character?.style || {}) } });
				return json({ character: db.setDoc(COL, existing.id, { ...data, folderId: existing.folderId }, { merge: true }) });
			}
			case 'setAction': {
				const existing = db.getDoc(COL, String(body.id));
				if (!existing) return json({ error: 'Not found' }, { status: 404 });
				const actions = [...(existing.actions || [])];
				const idx = actions.findIndex((a) => a.id === body.actionId);
				const next = { ...(idx >= 0 ? actions[idx] : { id: body.actionId }), ...(body.patch || {}) };
				if (idx >= 0) actions[idx] = next;
				else actions.push(next);
				return json({ character: db.setDoc(COL, existing.id, { actions }, { merge: true }) });
			}
			case 'delete':
				return json({ ok: db.deleteDoc(COL, String(body.id)) });
			default:
				return json({ error: `Unknown action: ${action}` }, { status: 400 });
		}
	} catch (error) {
		console.error('[api/characters]', action, error);
		return json({ error: error.message }, { status: 500 });
	}
}

