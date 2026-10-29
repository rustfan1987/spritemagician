<script>
	/**
	 * Characters — one reference image, a locked style, and a batch of actions.
	 * Every action is generated with the same seed and post-processed with
	 * the same settings, then filed under Characters/<name>/ in the library.
	 */
	import { onMount } from 'svelte';
	import { projectStore } from '$lib/stores/project.js';
	import { jobQueue } from '$lib/stores/jobQueue.js';
	import { createFile, notifyLibraryChanged } from '$lib/library/client.js';
	import { POSE_PRESETS, CHARACTER_ACTION_IDS, SIDE_ACTION_IDS, presetById } from '$lib/animation/presets.js';
	import { finalizeVideo, waitForJob, buildWanPrompt } from '$lib/animation/pipeline.js';
	import { prepareWanInput } from '$lib/animation/wanCanvas.js';
	import { clampImageLongEdge } from '$lib/utils/imagePrep.js';
	import { CHROMA_KEY_HEX } from '$lib/constants/chromaKey.js';

	let characters = $state([]);
	let selectedId = $state(null);
	let newName = $state('');
	let creating = $state(false);
	let error = $state('');
	let running = $state(false);
	let checked = $state(new Set(CHARACTER_ACTION_IDS));
	let project = $state({ firstFrame: null, fps: 12 });
	projectStore.subscribe((v) => (project = v));

	const selected = $derived(characters.find((c) => c.id === selectedId) || null);
	const actionPresets = $derived(POSE_PRESETS.filter((p) => p.id !== 'custom' && !p.id.startsWith('bust_') && (!!p.side === ((selected?.style?.view || 'front') === 'side'))));

	async function api(action, payload = {}) {
		const res = await fetch('/api/characters', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, ...payload })
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || `${action} failed`);
		return data;
	}

	async function load() {
		try {
			const res = await fetch('/api/characters');
			const data = await res.json();
			characters = data.characters || [];
			if (!selectedId && characters[0]) selectedId = characters[0].id;
		} catch (err) {
			error = err.message;
		}
	}

	function replaceCharacter(c) {
		characters = characters.map((x) => (x.id === c.id ? c : x));
	}

	async function createFromReference() {
		if (!project.firstFrame) {
			error = 'Load a reference sprite in Animate (or pick one from the File Tree) first.';
			return;
		}
		creating = true;
		error = '';
		try {
			const name = newName.trim() || `Character ${characters.length + 1}`;
			const { character } = await api('create', { character: { name, style: { fps: project.fps } } });
			// Store the reference image inside the character's folder.
			const up = await fetch('/api/upload-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageData: project.firstFrame, filename: 'reference.png', folder: character.folderId })
			});
			const uploaded = await up.json();
			if (!up.ok) throw new Error(uploaded.error || 'Reference upload failed');
			const fileId = await createFile('local', character.folderId, 'reference.png', uploaded.url, 'image', { source: 'character-reference' });
			const { character: updated } = await api('update', { id: character.id, character: { referenceUrl: uploaded.url, referenceFileId: fileId } });
			characters = [updated, ...characters];
			selectedId = updated.id;
			newName = '';
		} catch (err) {
			error = err.message;
		} finally {
			creating = false;
		}
	}

	async function updateStyle(patch) {
		if (!selected) return;
		const { character } = await api('update', { id: selected.id, character: { style: patch } });
		replaceCharacter(character);
	}

	async function rerollSeed() {
		if (!selected) return;
		const { character } = await api('update', { id: selected.id, character: { seed: Math.floor(Math.random() * 2147483647) } });
		replaceCharacter(character);
	}

	async function remove(c) {
		if (!confirm(`Delete character "${c.name}"? Files in its folder are kept.`)) return;
		await api('delete', { id: c.id });
		characters = characters.filter((x) => x.id !== c.id);
		if (selectedId === c.id) selectedId = characters[0]?.id || null;
	}

	function toggle(id) {
		const next = new Set(checked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		checked = next;
	}

	async function setAction(actionId, patch) {
		const { character } = await api('setAction', { id: selected.id, actionId, patch });
		replaceCharacter(character);
	}

	function actionState(id) {
		return selected?.actions?.find((a) => a.id === id) || null;
	}

	/**
	 * Perfect loops for the whole checked set in ONE server job
	 * (/api/perfect-loop): framing, Wan 2.2, loop matching, keying, colour
	 * match, loop check, union crop, save. Same code path as the Animate tab.
	 */
	let batchProgress = $state(null);
	const VERDICT = { perfect: 'bg-green-600', good: 'bg-lime-600', visible: 'bg-amber-500', broken: 'bg-red-600' };
	async function generatePerfectSet(c, presets) {
		const qid = jobQueue.addJob({ type: 'Animation', kind: 'animation', origin: 'character', name: `${c.name} · ${presets.length} perfect loops`, status: 'processing', message: 'Starting…' });
		for (const p of presets) await setAction(p.id, { status: 'running', error: null });
		try {
			const res = await fetch('/api/perfect-loop', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					image: c.referenceUrl, actions: presets.map((p) => p.id), subject: c.style.subject || '', view: c.style.view || 'front',
					reframe: c.style.view === 'side' && c.style.reframe !== false, seed: c.seed, name: c.name, folderId: c.folderId, replace: true
				})
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Could not start');
			const finished = await new Promise((resolve, reject) => {
				const timer = setInterval(async () => {
					try {
						const r = await fetch(`/api/generation-progress?jobId=${encodeURIComponent(data.jobId)}`);
						if (!r.ok) return;
						const pr = await r.json();
						batchProgress = pr;
						jobQueue.updateJob(qid, { message: pr.message, progress: pr.totalFrames ? Math.round((pr.currentFrame / pr.totalFrames) * 100) : 0 });
						if (pr.status === 'completed') { clearInterval(timer); resolve(pr); }
						else if (pr.status === 'error') { clearInterval(timer); reject(new Error(pr.message || 'Failed')); }
					} catch { /* keep polling */ }
				}, 2000);
			});
			for (const a of finished.actions || []) {
				if (a.status === 'done') await setAction(a.id, { status: 'done', fileId: a.fileId, frameCount: a.frames, thumbnailUrl: a.thumbnailUrl, loop: a.loop, error: null });
				else await setAction(a.id, { status: 'failed', error: a.error || 'failed' });
			}
			notifyLibraryChanged();
			jobQueue.completeJob(qid, { frameCount: finished.results?.length || 0 });
		} catch (err) {
			for (const p of presets) await setAction(p.id, { status: 'failed', error: err.message });
			jobQueue.failJob(qid, err.message);
			error = err.message;
		}
	}

	/** Manual per-action path (kept for the legacy settings). */
	async function generateAction(c, preset) {
		const style = c.style;
		const qid = jobQueue.addJob({ type: 'Animation', kind: 'animation', origin: 'character', name: `${c.name} · ${preset.name}`, status: 'processing', message: 'Preparing...' });
		await setAction(preset.id, { status: 'running', error: null });
		try {
			const source = await clampImageLongEdge(c.referenceUrl, 1024);
			const wanInput = await prepareWanInput(source, { chromaHex: CHROMA_KEY_HEX });
			const targetFrameCount = Math.max(8, Math.round(style.duration * style.fps));
			const perfect = style.loopMode === 'perfect';
			const res = await fetch('/api/generate-animation', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					referenceImage: wanInput.dataUrl,
					endImage: perfect ? wanInput.dataUrl : null,
					prompt: buildWanPrompt(preset.description, CHROMA_KEY_HEX),
					pose: preset.id,
					frameCount: targetFrameCount,
					duration: style.duration,
					fps: style.fps,
					loop: style.loopMode !== 'none',
					perfectLoop: perfect,
					model: perfect ? 'wan27' : 'wan22',
					seed: c.seed
				})
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Generation failed');
			const { videoUrl } = await waitForJob(data.jobId, {
				onProgress: (pr) => jobQueue.updateJob(qid, { message: pr.message || 'Generating...', progress: pr.totalFrames ? Math.round((pr.currentFrame / pr.totalFrames) * 100) : 0 })
			});
			const frames = await finalizeVideo({
				videoUrl,
				targetFrameCount,
				crop: wanInput.crop,
				original: wanInput.original,
				loopMode: style.loopMode,
				removeBackground: style.removeBackground,
				pixelate: { enabled: style.pixelate, pixelSize: style.pixelSize, colorLevels: style.colorLevels },
				canvasPadding: style.canvasPadding,
				onProgress: (m) => jobQueue.updateJob(qid, { message: m })
			});
			const save = await fetch('/api/save-animation', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: preset.id, frames, fps: style.fps, prompt: preset.description })
			});
			const saved = await save.json();
			if (!save.ok) throw new Error(saved.error || 'Save failed');
			const fileId = await createFile('local', c.folderId, `${preset.id}.anim.json`, saved.url, 'animation', {
				thumbnailUrl: saved.thumbnailUrl, frameCount: frames.length, fps: style.fps, seed: c.seed, pose: preset.id
			});
			notifyLibraryChanged();
			await setAction(preset.id, { status: 'done', fileId, frameCount: frames.length, thumbnailUrl: saved.thumbnailUrl, error: null });
			jobQueue.completeJob(qid, { frameCount: frames.length });
		} catch (err) {
			await setAction(preset.id, { status: 'failed', error: err.message });
			jobQueue.failJob(qid, err.message);
		}
	}

	async function generateChecked() {
		if (!selected || running) return;
		if (!selected.referenceUrl) {
			error = 'This character has no reference image.';
			return;
		}
		running = true;
		error = '';
		const todo = actionPresets.filter((p) => checked.has(p.id));
		await generatePerfectSet(selected, todo);
		running = false;
	}

	onMount(load);
</script>

<div class="h-full overflow-y-auto p-2 space-y-3 text-xs">
	{#if error}
		<div class="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-700">{error}</div>
	{/if}

	<div class="rounded-lg border border-gray-200 bg-white p-2 space-y-2">
		<p class="font-semibold text-gray-800">New character</p>
		<div class="flex gap-2">
			<input type="text" bind:value={newName} placeholder="Name (e.g. Knight)" class="flex-1 px-2 py-1 border rounded" />
			<button class="px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:bg-gray-400" onclick={createFromReference} disabled={creating || !project.firstFrame}>
				{creating ? '…' : 'Create from reference'}
			</button>
		</div>
		<p class="text-[10px] text-gray-500">Uses the sprite currently loaded in Animate as the reference. Each character gets its own folder under Characters/.</p>
	</div>

	{#if characters.length > 0}
		<div class="flex gap-1 flex-wrap">
			{#each characters as c (c.id)}
				<button class="px-2 py-1 rounded border {selectedId === c.id ? 'bg-amber-100 border-amber-400 text-amber-900' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'}" onclick={() => (selectedId = c.id)}>
					{c.name}
				</button>
			{/each}
		</div>
	{/if}

	{#if selected}
		<div class="rounded-lg border border-gray-200 bg-white p-2 space-y-2">
			<div class="flex items-start gap-3">
				{#if selected.referenceUrl}
					<img src={selected.referenceUrl} alt={selected.name} class="w-20 h-20 object-contain rounded border bg-gray-50" style="image-rendering: pixelated;" />
				{/if}
				<div class="flex-1 min-w-0">
					<p class="font-semibold text-gray-900 truncate">{selected.name}</p>
					<p class="text-[10px] text-gray-500">Seed {selected.seed} <button class="text-blue-600 underline ml-1" onclick={rerollSeed} disabled={running}>reroll</button></p>
					<p class="text-[10px] text-gray-500">{(selected.actions || []).filter((a) => a.status === 'done').length} actions done</p>
				</div>
				<button class="text-red-600 hover:underline text-[10px]" onclick={() => remove(selected)} disabled={running}>Delete</button>
			</div>

			<div class="grid grid-cols-1 gap-y-1 text-[11px] text-gray-700">
				<label>Who is this? <span class="text-gray-400">(2–4 features, optional)</span>
					<input type="text" class="w-full border rounded px-2 py-1 mt-0.5" placeholder="a knight in blue armor with a red plume" value={selected.style.subject || ''} onchange={(e) => updateStyle({ subject: e.currentTarget.value })} disabled={running} />
				</label>
				<label class="flex items-center justify-between gap-2">View
					<select class="border rounded px-1 py-0.5" value={selected.style.view || 'front'} onchange={(e) => { updateStyle({ view: e.currentTarget.value }); checked = new Set(e.currentTarget.value === 'side' ? SIDE_ACTION_IDS : CHARACTER_ACTION_IDS); }} disabled={running}>
						<option value="front">Front / as drawn</option>
						<option value="side">Side-scroller (profile →)</option>
					</select>
				</label>
				{#if (selected.style.view || 'front') === 'side'}
					<label class="flex items-center gap-1"><input type="checkbox" checked={selected.style.reframe !== false} onchange={(e) => updateStyle({ reframe: e.currentTarget.checked })} disabled={running} /> Redraw the reference in side profile first (+$0.04)</label>
				{/if}
			</div>
		</div>

		<div class="rounded-lg border border-gray-200 bg-white p-2 space-y-2">
			<div class="flex items-center justify-between">
				<p class="font-semibold text-gray-800">Actions</p>
				<button class="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400" onclick={generateChecked} disabled={running || checked.size === 0}>
					{running ? '⏳ Generating…' : `🚀 Generate ${checked.size} selected`}
				</button>
			</div>
			<div class="space-y-1">
				{#each actionPresets as preset (preset.id)}
					{@const st = actionState(preset.id)}
					<div class="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-gray-50">
						<input type="checkbox" checked={checked.has(preset.id)} onchange={() => toggle(preset.id)} disabled={running} />
						{#if st?.thumbnailUrl}
							<img src={st.thumbnailUrl} alt="" class="w-6 h-6 object-contain rounded border bg-gray-50" style="image-rendering: pixelated;" />
						{:else}
							<span class="w-6 h-6 inline-block"></span>
						{/if}
						<span class="flex-1 truncate" title={preset.description}>{preset.name}</span>
						{#if st?.status === 'done'}
							{#if st.loop?.verdict}<span class="text-[10px] text-white px-1.5 rounded {VERDICT[st.loop.verdict] || 'bg-gray-500'}" title="seam ÷ median step = {st.loop.ratio}">{st.loop.verdict}</span>{/if}
							<span class="text-green-700 text-[10px]">✓ {st.frameCount} frames</span>
						{:else if st?.status === 'running'}
							<span class="text-blue-700 text-[10px]">running…</span>
						{:else if st?.status === 'failed'}
							<span class="text-red-700 text-[10px]" title={st.error}>failed</span>
						{/if}
					</div>
				{/each}
			</div>
			{#if running && batchProgress?.message}<p class="text-[10px] text-blue-700">{batchProgress.message}</p>{/if}
			<p class="text-[10px] text-gray-500">One job, same seed for every action: framing, Wan 2.2, seamless loop matching, keying, colour match, loop check and one shared crop. Files land in Characters/{selected.name}/ (≈$0.05 per action).</p>
		</div>
	{:else if characters.length === 0}
		<p class="text-gray-500">No characters yet. Load a sprite in Animate, then create one here to batch-generate idle, walk, run, attack, cast, hit and death.</p>
	{/if}
</div>
