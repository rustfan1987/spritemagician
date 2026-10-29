<script>
	import { projectStore } from '$lib/stores/project.js';
	import { generateSpriteSheet, loadImage, downloadBlob } from '$lib/utils/spriteSheet.js';
	import { generateGif } from '$lib/utils/gifEncoder.js';
	import { generateMp4 } from '$lib/utils/mp4Encoder.js';
	import { userFiles } from '$lib/stores/userFiles.js';
	import { createFile, getItem } from '$lib/library/client.js';
	import FolderPicker from './FolderPicker.svelte';
	import { activeAssetStore } from '$lib/stores/activeAsset.js';
	import { buildGameSheet, packReadme, relinkGameSheet } from '$lib/utils/gameExport.js';
	import { cropToAnimationBounds } from '$lib/utils/animationBounds.js';
	
	let project = $state({ frames: [], fps: 12 });
	
	projectStore.subscribe(value => {
		project = value;
	});
	
	let isExporting = $state(false);
	let isGeneratingPreview = $state(false);
	let isGeneratingGif = $state(false);
	let isGeneratingMp4 = $state(false);
	let spriteSheetPreview = $state(null);
	let gifPreview = $state(null);
	let mp4Preview = $state(null);
	let showGifModal = $state(false);
	let showMp4Modal = $state(false);
	let useMp4 = $state(true); // Default to MP4 (more reliable)
	let previewColumns = $state(4);
	let frameSize = $state(128);
	let showFullSize = $state(false);
	let previewFrameIndex = $state(0);

	// Game-ready pack
	let gameName = $state('sprite');
	let gameTrim = $state(true);
	let gamePadding = $state(1);
	let gamePot = $state(true);
	let gameLoop = $state(true);
	let isBuildingPack = $state(false);
	let gamePackNote = $state('');

	// Crop to animation bounds: one box for ALL frames (union of silhouettes + padding)
	let boundsPadding = $state(6);
	let isCropping = $state(false);
	let cropNote = $state('');
	async function cropWholeAnimation() {
		if (!project.frames.length || isCropping) return;
		isCropping = true;
		cropNote = '';
		try {
			const { frames, box } = await cropToAnimationBounds(project.frames, {
				padding: Math.max(0, Math.min(64, Number(boundsPadding) || 0)),
				onProgress: (d, t) => (cropNote = `Measuring/cropping ${d}/${t}…`)
			});
			if (!box) { cropNote = 'No opaque pixels found (remove the background first).'; return; }
			projectStore.update((prj) => ({ ...prj, frames, currentFrame: 0 }));
			cropNote = `Cropped all ${frames.length} frames to ${box.w}×${box.h}.`;
		} catch (err) {
			cropNote = 'Crop failed: ' + (err?.message || err);
		} finally {
			isCropping = false;
		}
	}

	function safeBaseName(name) {
		return String(name || 'sprite').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'sprite';
	}

	function textToDataUrl(text, mime = 'application/json') {
		return `data:${mime};base64,${btoa(unescape(encodeURIComponent(text)))}`;
	}

	async function buildPack() {
		const name = safeBaseName(gameName);
		const sheet = await buildGameSheet(project.frames, {
			name, fps: project.fps || 12, trim: gameTrim, padding: Number(gamePadding) || 0, pot: gamePot, loop: gameLoop
		});
		return { name, sheet };
	}

	async function downloadGamePack() {
		if (!project.frames.length) return;
		isBuildingPack = true;
		gamePackNote = '';
		try {
			const { name, sheet } = await buildPack();
			downloadBlob(sheet.blob, `${name}.png`);
			const files = [
				[`${name}.json`, JSON.stringify(sheet.aseprite, null, 2), 'application/json'],
				[`${name}.tres`, sheet.godot, 'text/plain'],
				[`${name}.unity.json`, JSON.stringify(sheet.unity, null, 2), 'application/json'],
				[`${name}.README.txt`, packReadme(name, sheet), 'text/plain']
			];
			for (const [fname, text, mime] of files) {
				await new Promise((r) => setTimeout(r, 250));
				downloadBlob(new Blob([text], { type: mime }), fname);
			}
			gamePackNote = `Downloaded ${name}.png + Aseprite/Godot/Unity metadata (${sheet.width}×${sheet.height}, ${sheet.frames.length} frames).`;
		} catch (err) {
			gamePackNote = err.message || 'Export failed';
		} finally {
			isBuildingPack = false;
		}
	}

	async function saveGamePackToLibrary() {
		if (!project.frames.length) return;
		const folderId = saveFolderId || $activeAssetStore.folderId || $userFiles.currentFolderId || null;
		isBuildingPack = true;
		gamePackNote = '';
		try {
			const { name, sheet } = await buildPack();
			const pngDataUrl = await new Promise((resolve) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result);
				reader.readAsDataURL(sheet.blob);
			});
			const upload = await fetch('/api/upload-file', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageData: pngDataUrl, filename: `${name}.png`, folder: folderId })
			});
			const uploaded = await upload.json();
			if (!upload.ok) throw new Error(uploaded.error || 'Upload failed');
			const imageId = await createFile('local', folderId, `${name}.png`, uploaded.url, 'image', { source: 'game-pack', frameCount: sheet.frames.length, cell: sheet.cell });
			const imageItem = await getItem('local', imageId);
			if (!imageItem?.name) throw new Error('Saved sprite sheet could not be read back');
			const linked = relinkGameSheet(sheet, imageItem.name);
			await createFile('local', folderId, `${name}.json`, textToDataUrl(JSON.stringify(linked.aseprite, null, 2)), 'file', { source: 'game-pack' });
			await createFile('local', folderId, `${name}.tres`, textToDataUrl(linked.godot, 'text/plain'), 'file', { source: 'game-pack' });
			await createFile('local', folderId, `${name}.unity.json`, textToDataUrl(JSON.stringify(linked.unity, null, 2)), 'file', { source: 'game-pack' });
			gamePackNote = `Saved ${imageItem.name} + metadata to your library folder.`;
		} catch (err) {
			gamePackNote = err.message || 'Save failed';
		} finally {
			isBuildingPack = false;
		}
	}

	$effect(() => {
		const frameCount = project.frames.length;
		if (frameCount <= 1) {
			previewFrameIndex = 0;
			return;
		}
		const fps = Math.max(1, Number(project.fps) || 12);
		const intervalMs = Math.max(50, Math.floor(1000 / fps));
		const timer = setInterval(() => {
			previewFrameIndex = (previewFrameIndex + 1) % frameCount;
		}, intervalMs);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (previewFrameIndex >= project.frames.length) {
			previewFrameIndex = 0;
		}
	});

	// Save to folder state
	let showFolderPicker = $state(false);
	let saveFolderId = $state(null);
	let saveFolderPath = $state(null);
	let saveName = $state('');
	let isSaving = $state(false);
	let exportSaveNote = $state('');
	let featureP1ActiveAssetDestinationGuard = $state(true);
	const FEATURE_P1_ACTIVE_ASSET_GUARD_KEY = 'sm.ff.p1_active_asset_destination_guard';

	if (typeof window !== 'undefined') {
		try {
			const rawAssetGuardFlag = localStorage.getItem(FEATURE_P1_ACTIVE_ASSET_GUARD_KEY);
			if (rawAssetGuardFlag === '0') {
				featureP1ActiveAssetDestinationGuard = false;
			}
		} catch {
			// ignore localStorage access errors
		}
	}

	function emitAssetUiEvent(name, payload) {
		if (typeof window === 'undefined') return;
		window.dispatchEvent(new CustomEvent(name, { detail: payload }));
	}

	function emitAssetTelemetry(eventName, payload) {
		if (typeof window === 'undefined') return;
		window.dispatchEvent(
			new CustomEvent('smTelemetryEvent', {
				detail: {
					eventName,
					payload,
					ts: new Date().toISOString()
				}
			})
		);
	}

	function closePreview() {
		if (spriteSheetPreview) {
			URL.revokeObjectURL(spriteSheetPreview);
		}
		spriteSheetPreview = null;
		showFullSize = false;
	}
	
	function openFullSize() {
		showFullSize = true;
	}
	
	function closeFullSize() {
		showFullSize = false;
	}
	
	async function generatePreview() {
		if (project.frames.length === 0) return;
		isGeneratingPreview = true;
		try {
			const images = await Promise.all(project.frames.map(loadImage));
			const columns = Math.min(previewColumns, project.frames.length);
			const blob = await generateSpriteSheet(images, frameSize, frameSize, columns);
			
			// Clean up old preview URL
			if (spriteSheetPreview) {
				URL.revokeObjectURL(spriteSheetPreview);
			}
			spriteSheetPreview = URL.createObjectURL(blob);
		} catch (e) {
			console.error('Preview error:', e);
			spriteSheetPreview = null;
		} finally {
			isGeneratingPreview = false;
		}
	}

	async function handleExportFrames() {
		if (project.frames.length === 0) return;
		isExporting = true;
		try {
			for (let i = 0; i < project.frames.length; i++) {
				const frame = project.frames[i];
				const img = await loadImage(frame);
				
				const canvas = document.createElement('canvas');
				canvas.width = frameSize;
				canvas.height = frameSize;
				const ctx = canvas.getContext('2d');
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(img, 0, 0, frameSize, frameSize);
				
				canvas.toBlob((blob) => {
					downloadBlob(blob, `frame_${String(i).padStart(3, '0')}.png`);
				}, 'image/png');
				
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		} finally {
			isExporting = false;
		}
	}

	async function handleExportSpriteSheet() {
		if (project.frames.length === 0) return;
		isExporting = true;
		try {
			const images = await Promise.all(project.frames.map(loadImage));
			const columns = Math.min(previewColumns, project.frames.length);
			const blob = await generateSpriteSheet(images, frameSize, frameSize, columns);
			downloadBlob(blob, 'sprite_sheet.png');
		} finally {
			isExporting = false;
		}
	}
	
	async function handlePreviewVideo() {
		if (project.frames.length === 0) return;
		
		if (useMp4) {
			isGeneratingMp4 = true;
			try {
				const blob = await generateMp4(project.frames, frameSize, project.fps || 12);
				// Clean up old preview
				if (mp4Preview) {
					URL.revokeObjectURL(mp4Preview);
				}
				mp4Preview = URL.createObjectURL(blob);
				showMp4Modal = true;
			} catch (e) {
				console.error('MP4 generation error:', e);
				alert('Failed to generate MP4: ' + e.message + '\n\nTrying GIF instead...');
				// Fallback to GIF
				useMp4 = false;
				await handlePreviewVideo();
			} finally {
				isGeneratingMp4 = false;
			}
		} else {
			isGeneratingGif = true;
			try {
				const blob = await generateGif(project.frames, frameSize, project.fps || 12);
				// Clean up old preview
				if (gifPreview) {
					URL.revokeObjectURL(gifPreview);
				}
				gifPreview = URL.createObjectURL(blob);
				showGifModal = true;
			} catch (e) {
				console.error('GIF generation error:', e);
				alert('Failed to generate GIF: ' + e.message);
			} finally {
				isGeneratingGif = false;
			}
		}
	}
	
	async function handleDownloadVideo() {
		if (project.frames.length === 0) return;
		
		if (useMp4) {
			isGeneratingMp4 = true;
			try {
				const blob = await generateMp4(project.frames, frameSize, project.fps || 12);
				downloadBlob(blob, 'animation.mp4');
			} catch (e) {
				console.error('MP4 generation error:', e);
				alert('Failed to generate MP4: ' + e.message + '\n\nTrying GIF instead...');
				// Fallback to GIF
				useMp4 = false;
				await handleDownloadVideo();
			} finally {
				isGeneratingMp4 = false;
			}
		} else {
			isGeneratingGif = true;
			try {
				const blob = await generateGif(project.frames, frameSize, project.fps || 12);
				downloadBlob(blob, 'animation.gif');
			} catch (e) {
				console.error('GIF generation error:', e);
				alert('Failed to generate GIF: ' + e.message);
			} finally {
				isGeneratingGif = false;
			}
		}
	}
	
	function closeMp4Modal() {
		showMp4Modal = false;
	}
	
	function downloadMp4FromModal() {
		if (mp4Preview) {
			const a = document.createElement('a');
			a.href = mp4Preview;
			a.download = 'animation.mp4';
			a.click();
		}
	}
	
	function closeGifModal() {
		showGifModal = false;
	}
	
	function downloadGifFromModal() {
		if (gifPreview) {
			const a = document.createElement('a');
			a.href = gifPreview;
			a.download = 'animation.gif';
			a.click();
		}
	}

	async function onFolderSelect(folderId, folderPath) {
		saveFolderId = folderId;
		saveFolderPath = folderPath;
		showFolderPicker = false;
		if (featureP1ActiveAssetDestinationGuard) {
			const confirmedPayload = {
				destinationPath: folderPath || null,
				confirmationSource: 'explicit_picker_select'
			};
			emitAssetUiEvent('asset.destination.confirmed', confirmedPayload);
			emitAssetTelemetry('sm.p1.save_destination_confirmed', confirmedPayload);
		}
		// Auto-save after selecting folder
		if (project.frames.length > 0) {
			await performSave();
		}
	}

	async function performSave() {
		if (!project.frames.length) return;
		if (featureP1ActiveAssetDestinationGuard) {
			const confirmedPayload = {
				destinationPath: saveFolderPath || null,
				confirmationSource: 'dialog_submit'
			};
			emitAssetUiEvent('asset.destination.confirmed', confirmedPayload);
			emitAssetTelemetry('sm.p1.save_destination_confirmed', confirmedPayload);
		}

		isSaving = true;
		try {
			const uid = userFiles.getUid();
			if (!uid) throw new Error('Not signed in');

			const animationName = saveName.trim() || project.prompt || `animation_${Date.now()}`;
			const sanitizedName = animationName.slice(0, 40).replace(/[^a-zA-Z0-9_\- ]/g, '_');

			// Use the dedicated save-animation endpoint (avoids double-base64 overhead)
			const res = await fetch('/api/save-animation', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: sanitizedName,
					frames: project.frames,
					fps: project.fps || 12,
					prompt: project.prompt || ''
				})
			});
			if (!res.ok) {
				const errData = await res.json().catch(() => ({}));
				throw new Error(errData.error || 'Upload failed');
			}
			const { url, frameCount, thumbnailUrl } = await res.json();

			// Create a library entry so it appears in the file tree
			const fname = `${sanitizedName}.anim.json`;
			await createFile(uid, saveFolderId, fname, url, 'animation', {
				sourceType: 'animation',
				frameCount,
				fps: project.fps || 12,
				animationName: sanitizedName,
				prompt: project.prompt || '',
				thumbnailUrl: thumbnailUrl || null
			});

			exportSaveNote = `Animation saved! ${frameCount} frames -> ${saveFolderPath || 'root'}`;
		} catch (err) {
			console.error('Save error:', err);
			exportSaveNote = 'Failed to save animation: ' + err.message;
		} finally {
			isSaving = false;
		}
	}

	async function saveToFolder() {
		if (!project.frames.length) {
			exportSaveNote = 'No frames to save.';
			return;
		}
		if (featureP1ActiveAssetDestinationGuard && !$activeAssetStore?.folderId && !saveFolderId) {
			const blockedPayload = {
				entryPoint: 'export',
				sourceType: 'animation'
			};
			emitAssetUiEvent('asset.destination.blocked_missing_context', blockedPayload);
			emitAssetTelemetry('sm.p1.save_without_active_asset_blocked', blockedPayload);
			exportSaveNote = 'Select an active asset folder first.';
			return;
		}
		
		if (!saveFolderId) {
			saveFolderId = $activeAssetStore?.folderId || null;
			saveFolderPath = $activeAssetStore?.folderPath || $activeAssetStore?.folderName || null;
			exportSaveNote = '';
			showFolderPicker = true;
			return;
		}

		exportSaveNote = '';
		await performSave();
	}
</script>

<div class="space-y-3">
	{#if project.frames.length > 0}
		<!-- Settings -->
		<div class="grid grid-cols-2 gap-2">
			<div>
				<label class="block text-xs text-gray-600 mb-1">Columns</label>
				<select 
					bind:value={previewColumns}
					class="w-full px-2 py-1 text-xs border rounded"
				>
					<option value={2}>2</option>
					<option value={4}>4</option>
					<option value={6}>6</option>
					<option value={8}>8</option>
					<option value={project.frames.length}>1 Row ({project.frames.length})</option>
				</select>
			</div>
			<div>
				<label class="block text-xs text-gray-600 mb-1">Frame Size</label>
				<select 
					bind:value={frameSize}
					class="w-full px-2 py-1 text-xs border rounded"
				>
					<option value={64}>64px</option>
					<option value={128}>128px</option>
					<option value={256}>256px</option>
					<option value={512}>512px</option>
				</select>
			</div>
		</div>

		<!-- Crop to animation bounds -->
		<div class="bg-sky-50 border border-sky-200 rounded p-2 space-y-1.5">
			<div class="flex items-center justify-between">
				<p class="text-xs font-semibold text-sky-900">✂️ Crop to animation bounds</p>
				<label class="text-[11px] text-sky-800 flex items-center gap-1">Padding
					<input type="number" min="0" max="64" bind:value={boundsPadding} class="w-12 px-1 py-0.5 border rounded text-[11px]" /> px
				</label>
			</div>
			<p class="text-[10px] text-sky-800">Measures every frame, takes the union box, and crops all frames to it. Nothing gets cut off and the character does not jitter.</p>
			<button class="w-full px-2 py-1.5 text-xs rounded bg-sky-600 text-white hover:bg-sky-700 disabled:bg-gray-400" onclick={cropWholeAnimation} disabled={isCropping || !project.frames.length}>
				{isCropping ? '⏳ Cropping…' : '✂️ Crop all frames to the animation'}
			</button>
			{#if cropNote}<p class="text-[10px] text-sky-800">{cropNote}</p>{/if}
		</div>

		<!-- Game-ready pack -->
		<div class="bg-emerald-50 border border-emerald-200 rounded p-2 space-y-2">
			<div class="flex items-center justify-between">
				<p class="text-xs font-semibold text-emerald-900">🎮 Game-ready pack</p>
				<p class="text-[10px] text-emerald-700">Aseprite · Godot 4 · Unity</p>
			</div>
			<div class="grid grid-cols-2 gap-2 text-[11px]">
				<label class="col-span-2">Name
					<input type="text" bind:value={gameName} class="w-full px-2 py-1 border rounded text-xs" placeholder="hero_idle" />
				</label>
				<label class="flex items-center gap-1"><input type="checkbox" bind:checked={gameTrim} class="w-3 h-3" /> Trim common border</label>
				<label class="flex items-center gap-1"><input type="checkbox" bind:checked={gamePot} class="w-3 h-3" /> Power-of-two sheet</label>
				<label class="flex items-center gap-1"><input type="checkbox" bind:checked={gameLoop} class="w-3 h-3" /> Loop flag</label>
				<label class="flex items-center gap-1">Padding
					<input type="number" min="0" max="16" bind:value={gamePadding} class="w-12 px-1 py-0.5 border rounded text-[11px]" /> px
				</label>
			</div>
			<div class="flex gap-2">
				<button class="flex-1 px-2 py-1.5 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-400" onclick={downloadGamePack} disabled={isBuildingPack || !project.frames.length}>
					{isBuildingPack ? '⏳ Building…' : '⬇ Download pack'}
				</button>
				<button class="flex-1 px-2 py-1.5 text-xs rounded border border-emerald-600 text-emerald-800 hover:bg-emerald-100 disabled:text-gray-400" onclick={saveGamePackToLibrary} disabled={isBuildingPack || !project.frames.length}>
					💾 Save to library
				</button>
			</div>
			{#if gamePackNote}<p class="text-[10px] text-emerald-800">{gamePackNote}</p>{/if}
		</div>

		<!-- Live Animation Preview -->
		<div class="bg-gray-100 border rounded p-2">
			<div class="flex items-center justify-between mb-2">
				<p class="text-xs text-gray-600">Animated Sprite Preview</p>
				<p class="text-[10px] text-gray-500">{project.fps || 12} fps</p>
			</div>
			<div class="h-44 bg-white border rounded flex items-center justify-center overflow-hidden">
				<img
					src={project.frames[Math.min(previewFrameIndex, Math.max(0, project.frames.length - 1))]}
					alt="Animated sprite preview"
					class="max-w-full max-h-full object-contain"
					style="image-rendering: pixelated;"
				/>
			</div>
		</div>
		
		<!-- Spritesheet Preview -->
		{#if spriteSheetPreview}
			<div class="bg-gray-100 border rounded p-2 relative">
				<div class="flex items-center justify-between mb-2">
					<p class="text-xs text-gray-600">Spritesheet Preview <span class="text-gray-400">(click to enlarge)</span></p>
					<button
						onclick={closePreview}
						class="text-gray-500 hover:text-gray-700 text-sm px-1"
						title="Close preview"
					>
						✕
					</button>
				</div>
				<img 
					src={spriteSheetPreview} 
					alt="Spritesheet preview" 
					class="w-full max-h-48 object-contain bg-white border rounded cursor-pointer hover:opacity-80 transition-opacity"
					style="image-rendering: pixelated;"
					onclick={openFullSize}
					onkeydown={(e) => { if (e.key === 'Enter') openFullSize(); }}
					tabindex="0"
					role="button"
				/>
			</div>
		{/if}
	{/if}
	
	<!-- Full Size Modal -->
	{#if showFullSize && spriteSheetPreview}
		<div 
			class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
			onclick={closeFullSize}
			onkeydown={(e) => { if (e.key === 'Escape') closeFullSize(); }}
			tabindex="0"
			role="dialog"
		>
			<div class="relative max-w-full max-h-full">
				<button
					onclick={closeFullSize}
					class="absolute -top-10 right-0 text-white hover:text-gray-300 text-2xl"
					title="Close"
				>
					✕
				</button>
				<img 
					src={spriteSheetPreview} 
					alt="Spritesheet full size" 
					class="max-w-full max-h-[90vh] object-contain bg-gray-900 border-2 border-gray-700 rounded"
					style="image-rendering: pixelated;"
					onclick={(e) => e.stopPropagation()}
				/>
				<p class="text-center text-gray-400 text-sm mt-2">
					{project.frames.length} frames • {previewColumns} cols • {frameSize}px
				</p>
			</div>
		</div>
	{/if}
	
	<!-- MP4 Preview Modal -->
	{#if showMp4Modal && mp4Preview}
		<div 
			class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
			onclick={closeMp4Modal}
			onkeydown={(e) => { if (e.key === 'Escape') closeMp4Modal(); }}
			tabindex="0"
			role="dialog"
		>
			<div class="relative max-w-full max-h-full bg-gray-900 rounded-lg p-4" onclick={(e) => e.stopPropagation()}>
				<button
					onclick={closeMp4Modal}
					class="absolute top-2 right-2 text-white hover:text-gray-300 text-2xl z-10"
					title="Close"
				>
					✕
				</button>
				
				<h3 class="text-white text-lg font-bold mb-3 text-center">🎬 Video Preview</h3>
				
				<div class="bg-gray-700 rounded-lg p-2 mb-3">
					<video 
						src={mp4Preview} 
						controls
						autoplay
						loop
						class="max-w-full max-h-[60vh] object-contain mx-auto"
						style="image-rendering: pixelated;"
					/>
				</div>
				
				<div class="flex justify-center gap-3">
					<button
						onclick={downloadMp4FromModal}
						class="px-4 py-2 bg-pink-500 text-white rounded hover:bg-pink-600 font-medium"
					>
						⬇️ Download MP4
					</button>
					<button
						onclick={closeMp4Modal}
						class="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-500"
					>
						Close
					</button>
				</div>
				
				<p class="text-center text-gray-400 text-sm mt-3">
					{project.frames.length} frames • {project.fps || 12} fps • {frameSize}px
				</p>
			</div>
		</div>
	{/if}

	<!-- GIF Preview Modal (fallback) -->
	{#if showGifModal && gifPreview}
		<div 
			class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
			onclick={closeGifModal}
			onkeydown={(e) => { if (e.key === 'Escape') closeGifModal(); }}
			tabindex="0"
			role="dialog"
		>
			<div class="relative max-w-full max-h-full bg-gray-900 rounded-lg p-4" onclick={(e) => e.stopPropagation()}>
				<button
					onclick={closeGifModal}
					class="absolute top-2 right-2 text-white hover:text-gray-300 text-2xl z-10"
					title="Close"
				>
					✕
				</button>
				
				<h3 class="text-white text-lg font-bold mb-3 text-center">🎬 GIF Preview</h3>
				
				<div class="bg-gray-700 rounded-lg p-2 mb-3">
					<img 
						src={gifPreview} 
						alt="Animation GIF preview" 
						class="max-w-full max-h-[60vh] object-contain mx-auto"
						style="image-rendering: pixelated;"
					/>
				</div>
				
				<div class="flex justify-center gap-3">
					<button
						onclick={downloadGifFromModal}
						class="px-4 py-2 bg-pink-500 text-white rounded hover:bg-pink-600 font-medium"
					>
						⬇️ Download GIF
					</button>
					<button
						onclick={closeGifModal}
						class="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-500"
					>
						Close
					</button>
				</div>
				
				<p class="text-center text-gray-400 text-sm mt-3">
					{project.frames.length} frames • {project.fps || 12} fps • {frameSize}px
				</p>
			</div>
		</div>
	{/if}
	
	<!-- Action Buttons Row 1 -->
	<div class="grid grid-cols-3 gap-2">
		<button
			class="px-2 py-1.5 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
			onclick={generatePreview}
			disabled={isGeneratingPreview || project.frames.length === 0}
		>
			{isGeneratingPreview ? '...' : '👁️ Preview'}
		</button>
		
		<button
			class="px-2 py-1.5 text-xs bg-green-500 text-white rounded hover:bg-green-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
			onclick={handleExportFrames}
			disabled={isExporting || project.frames.length === 0}
		>
			{isExporting ? '...' : '📁 Frames'}
		</button>
		
		<button
			class="px-2 py-1.5 text-xs bg-purple-500 text-white rounded hover:bg-purple-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
			onclick={handleExportSpriteSheet}
			disabled={isExporting || project.frames.length === 0}
		>
			{isExporting ? '...' : '🖼️ Sheet'}
		</button>
	</div>
	
	<!-- Video Buttons Row 2 -->
	<div class="space-y-2">
		<div class="flex items-center gap-2 text-[10px] text-gray-500">
			<label class="flex items-center gap-1 cursor-pointer">
				<input type="checkbox" bind:checked={useMp4} class="w-3 h-3" />
				<span>Use MP4 (more reliable)</span>
			</label>
		</div>
		<div class="grid grid-cols-2 gap-2">
			<button
				class="px-2 py-1.5 text-xs bg-orange-500 text-white rounded hover:bg-orange-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
				onclick={handlePreviewVideo}
				disabled={(isGeneratingMp4 || isGeneratingGif) || project.frames.length === 0}
			>
				{(isGeneratingMp4 || isGeneratingGif) ? 'Generating...' : useMp4 ? '🎬 Preview MP4' : '🎬 Preview GIF'}
			</button>
			
			<button
				class="px-2 py-1.5 text-xs bg-pink-500 text-white rounded hover:bg-pink-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
				onclick={handleDownloadVideo}
				disabled={(isGeneratingMp4 || isGeneratingGif) || project.frames.length === 0}
			>
				{(isGeneratingMp4 || isGeneratingGif) ? 'Generating...' : useMp4 ? '⬇️ Download MP4' : '⬇️ Download GIF'}
			</button>
		</div>
	</div>

	<!-- Save to Folder -->
	{#if project.frames.length > 0}
		<div class="border-t pt-2 mt-2 space-y-2">
			<!-- Name input -->
			<div class="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
				<span class="text-[10px] text-gray-500 font-medium whitespace-nowrap">Name:</span>
				<input
					type="text"
					class="flex-1 px-2 py-1 text-[11px] rounded border border-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none bg-white"
					bind:value={saveName}
					placeholder="Enter file name…"
				/>
			</div>

			<!-- Folder picker -->
			<div class="flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-200">
				<span class="text-[10px] text-gray-500 font-medium whitespace-nowrap">Save to:</span>
				<button
					class="flex-1 text-left px-2 py-1 text-[11px] rounded border transition-colors truncate
						{saveFolderPath
							? 'bg-white border-blue-300 text-blue-700 hover:bg-blue-50 font-medium'
							: 'bg-white border-gray-300 text-gray-400 hover:bg-gray-100'}"
					onclick={() => showFolderPicker = true}
				>
					{saveFolderPath || '📁 Choose folder…'}
				</button>
				{#if saveFolderPath}
					<button
						class="text-[10px] text-gray-400 hover:text-red-500"
						onclick={() => { saveFolderId = null; saveFolderPath = null; }}
						title="Clear"
					>✕</button>
				{/if}
			</div>
			{#if featureP1ActiveAssetDestinationGuard && saveFolderPath}
				<p class="text-[10px] text-emerald-700 px-1">Saving to: {saveFolderPath}</p>
			{:else if featureP1ActiveAssetDestinationGuard}
				<p class="text-[10px] text-amber-700 px-1">No active asset selected. Save requires destination context.</p>
			{/if}

			<button
				class="w-full px-2 py-1.5 text-xs bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
				onclick={saveToFolder}
				disabled={isSaving || project.frames.length === 0}
			>
				{#if isSaving}
					<span class="inline-flex items-center gap-1.5">
						<span class="animate-spin">⏳</span> Saving {project.frames.length} frames...
					</span>
				{:else}
					💾 Save Animation to Folder
				{/if}
			</button>
			{#if exportSaveNote}
				<p class="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">{exportSaveNote}</p>
			{/if}
		</div>
	{/if}

	{#if project.frames.length > 0}
		<p class="text-xs text-gray-600 text-center">
			{project.frames.length} frames • {previewColumns} cols • {frameSize}px
		</p>
	{:else}
		<p class="text-xs text-gray-500 text-center">Generate frames to export</p>
	{/if}
</div>

<!-- Folder Picker Modal -->
{#if showFolderPicker}
	<FolderPicker
		onSelect={onFolderSelect}
		onClose={() => showFolderPicker = false}
		startFolderId={$activeAssetStore.folderId}
		startFolderName={$activeAssetStore.folderName || 'Asset'}
	/>
{/if}
