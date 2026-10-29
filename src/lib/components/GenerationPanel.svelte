<script>
	// AI AGENTS: a headless equivalent of this panel's generate → finalize flow
	// lives in scripts/animate.mjs (documented step by step). Prefer it for
	// batch work; keep framing/loop behaviour in sync with pipeline.js.
	import { browser } from '$app/environment';
	import { projectStore, updateFPS } from '$lib/stores/project.js';
	import { poseStore } from '$lib/stores/poses.js';
	import { jobQueue } from '$lib/stores/jobQueue.js';
	import { completedJobs } from '$lib/stores/completedJobs.js';
	import FrameUpload from './FrameUpload.svelte';
	import { finalizeVideo, waitForJob, buildWanPrompt } from '$lib/animation/pipeline.js';
	import { prepareWanInput } from '$lib/animation/wanCanvas.js';
	import { POSE_PRESETS, SIDE_ACTION_IDS, CHARACTER_ACTION_IDS, presetById } from '$lib/animation/presets.js';
	import { notifyLibraryChanged } from '$lib/library/client.js';
	import { onMount } from 'svelte';
	import { clampImageLongEdge } from '$lib/utils/imagePrep.js';
	import { CHROMA_KEY_HEX, CHROMA_KEY_TOLERANCE } from '$lib/constants/chromaKey.js';
	import { activeAssetStore } from '$lib/stores/activeAsset.js';
	
	let project = $state({ frames: [], fps: 12, firstFrame: null, frameCount: 8 });
	let savedPoses = $state({ poses: [] });
	
	poseStore.subscribe(value => {
		savedPoses = value;
	});
	
	projectStore.subscribe(value => {
		project = value;
	});
	
	// ── Perfect loops (default mode) ─────────────────────────────────────────
	// One button runs the whole pipeline on the server (src/lib/server/perfectLoop.js):
	// canvas framing → Wan 2.2 → loop matching → chroma key → colour match →
	// loop check → union crop → saved to the library. No knobs to get wrong.
	let costPerClipUsd = $state(0.05);
	const PL_STATE_KEY = 'spritemagician.animate.perfect.v1';
	let mode = $state('perfect'); // 'perfect' | 'manual'
	let plSubject = $state('');
	let plView = $state('front'); // 'front' | 'side'
	let plReframe = $state(true); // side: redraw the sprite in profile first
	let plSeed = $state(null);
	let plName = $state('');
	let plChecked = $state(new Set());
	let plCustom = $state('');
	let plRunning = $state(false);
	let plError = $state('');
	let plProgress = $state(null);
	let plResults = $state([]);
	let plPoll = null;
	const PL_VERDICT = { perfect: 'bg-green-600', good: 'bg-lime-600', visible: 'bg-amber-500', broken: 'bg-red-600' };
	const plSets = $derived(plView === 'side'
		? POSE_PRESETS.filter((p) => p.side)
		: POSE_PRESETS.filter((p) => !p.side && p.id !== 'custom' && !p.id.startsWith('bust_')));
	const plGroups = $derived([...new Set(plSets.map((p) => p.group))]);
	const plCost = $derived((plChecked.size + (plCustom.trim() ? 1 : 0)) * costPerClipUsd + (plView === 'side' && plReframe ? 0.04 : 0));

	function plDefaults() {
		plChecked = new Set(plView === 'side' ? SIDE_ACTION_IDS : CHARACTER_ACTION_IDS.filter((id) => id !== 'death'));
	}
	function plToggle(id) {
		const next = new Set(plChecked);
		next.has(id) ? next.delete(id) : next.add(id);
		plChecked = next;
	}
	function plSave() {
		if (!browser) return;
		try { localStorage.setItem(PL_STATE_KEY, JSON.stringify({ mode, plSubject, plView, plReframe, plName, checked: [...plChecked] })); } catch { /* ignore */ }
	}
	if (browser) {
		try {
			const s = JSON.parse(localStorage.getItem(PL_STATE_KEY) || 'null');
			if (s) {
				if (s.mode === 'manual' || s.mode === 'perfect') mode = s.mode;
				if (typeof s.plSubject === 'string') plSubject = s.plSubject;
				if (s.plView === 'side' || s.plView === 'front') plView = s.plView;
				if (typeof s.plReframe === 'boolean') plReframe = s.plReframe;
				if (typeof s.plName === 'string') plName = s.plName;
				if (Array.isArray(s.checked) && s.checked.length) plChecked = new Set(s.checked);
			}
		} catch { /* ignore */ }
	}
	if (!plChecked.size) plDefaults();

	async function runPerfectLoops() {
		if (!project.firstFrame || plRunning) return;
		const actions = [...plChecked].filter((id) => presetById(id));
		if (plCustom.trim()) actions.push({ id: plCustom.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24), text: plCustom.trim() });
		if (!actions.length) { plError = 'Pick at least one action.'; return; }
		plRunning = true; plError = ''; plResults = []; plProgress = { status: 'starting', message: 'Starting…', actions: [] };
		plSave();
		try {
			const res = await fetch('/api/perfect-loop', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					image: project.firstFrame, actions, subject: plSubject, view: plView, reframe: plView === 'side' && plReframe,
					seed: plSeed ?? undefined, name: plName || project.projectName || 'sprite', replace: true
				})
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Could not start');
			const qid = jobQueue.addJob({ type: 'Animation', kind: 'animation', origin: 'perfect-loop', name: `Perfect loops × ${actions.length}`, status: 'processing', message: 'Starting…' });
			await new Promise((resolve, reject) => {
				plPoll = setInterval(async () => {
					try {
						const r = await fetch(`/api/generation-progress?jobId=${encodeURIComponent(data.jobId)}`);
						if (!r.ok) return;
						const p = await r.json();
						plProgress = p;
						jobQueue.updateJob(qid, { message: p.message, progress: p.totalFrames ? Math.round((p.currentFrame / p.totalFrames) * 100) : 0 });
						if (p.status === 'completed') { clearInterval(plPoll); jobQueue.completeJob(qid, { frameCount: p.results?.length || 0 }); resolve(p); }
						else if (p.status === 'error') { clearInterval(plPoll); jobQueue.failJob(qid, p.message); reject(new Error(p.message || 'Failed')); }
					} catch { /* keep polling */ }
				}, 2000);
			});
			plResults = plProgress.results || [];
			notifyLibraryChanged();
			if (plResults[0]) await loadResult(plResults[0]);
		} catch (err) {
			plError = err.message;
		} finally {
			clearInterval(plPoll);
			plRunning = false;
		}
	}

	/** Load a finished animation into the project (Preview / Export). */
	async function loadResult(r) {
		try {
			const res = await fetch(`/api/load-animation?url=${encodeURIComponent(r.url)}`);
			const data = await res.json();
			if (!res.ok || !data.frames?.length) throw new Error(data.error || 'Could not load');
			projectStore.update((p) => ({ ...p, frames: data.frames, fps: data.fps || 12, currentFrame: 0, projectName: data.name || p.projectName, _animationLoaded: true }));
		} catch (err) {
			plError = err.message;
		}
	}

	let prompt = $state('');
	let isGenerating = $state(false);
	let generationError = $state(null);
	let progress = $state({ currentFrame: 0, totalFrames: 0, status: 'idle', message: '' });
	let progressPollInterval = $state(null);
	let jobId = $state(null);
	let queueJobId = $state(null); // For job queue tracking
	const ANIMATE_STATE_KEY = 'spritemagician.animate.panel.v1';
	
	const MIN_TARGET_FRAMES = 12;
	const MAX_TARGET_FRAMES = 96;
	const MIN_MANUAL_FRAMES = 8;
	const MAX_MANUAL_FRAMES = 120;

	// Animation settings tuned for faster sprite iteration
	let duration = $state(3); // WAN 2.7 is most coherent for short 2–5 second clips
	let motionAmount = $state(50); // 1-255, lower = subtle motion for sprites
	let shouldLoop = $state(false); // Loop animation back to first frame
	let perfectLoop = $state(false); // Force end/start seam smoothing + exact closure
	let staticAssetLock = $state(false); // Keep object anchored in place (no drift/rotation/jitter)
	let selectedPose = $state('custom'); // Presets only populate the raw prompt field
	
	// Advanced settings for better accuracy and loops
	let showAdvanced = $state(false);
	let guidanceScale = $state(null); // null = use model default (typically 7.5)
	let seed = $state(null); // null = random seed
	let negativePrompt = $state(''); // Additional negative prompt

	// FLF-specific settings (for interpolation mode) — quality-focused defaults
	// These MUST match the server-side defaults in generate-animation/+server.js
	// Source: lucataco/wan-2.2-first-last-frame model schema (Lightning LoRA)
	let flfDurationSeconds = $state(5);     // model default: 5
	let flfInferenceSteps = $state(8);      // model default: 8 (Lightning — low steps!)
	let flfGuidanceScale = $state(1);       // model default: 1 (distilled — low guidance!)
	let flfGuidanceScale2 = $state(1);      // model default: 1 (distilled — low guidance!)
	let flfShift = $state(8);               // model default: 8
	let flfSeed = $state(null);             // null = random
	let flfNegativePrompt = $state('');     // user additions to default Chinese neg prompt
	
	// Interpolation mode (start → end frame)
	let useInterpolation = $state(false);
	let endFrame = $state(null);
	let frameTargetMode = $state('auto'); // 'auto' | 'manual'
	let manualFrameCount = $state(16);
	let inputLongEdge = $state(1024); // Cap source image long edge before video generation
	
	function handleEndFrameUpload(dataUrl) {
		endFrame = dataUrl;
		projectStore.update(p => ({ ...p, lastFrame: dataUrl }));
	}
	
	function clearEndFrame() {
		endFrame = null;
		projectStore.update(p => ({ ...p, lastFrame: null }));
		useInterpolation = false; // Disable interpolation when end frame is cleared
	}
	
	// Sync endFrame with projectStore.lastFrame so file tree selection works
	$effect(() => {
		if (project.lastFrame && project.lastFrame !== endFrame) {
			endFrame = project.lastFrame;
			useInterpolation = true; // Auto-enable interpolation when end frame is set from file tree
		}
	});
	
	const posePresets = POSE_PRESETS;

	// Batch + canvas options
	let seedCount = $state(1); // 1 | 2 | 4 parallel seeds
	let useWanCanvas = $state(true); // paint sprite on a 832×480 chroma canvas, crop back after
	let batchErrors = $state([]);
	onMount(async () => {
		try {
			const res = await fetch('/api/usage');
			const data = await res.json();
			costPerClipUsd = data?.models?.wan22?.costUsd ?? 0.05;
		} catch { /* ignore */ }
	});
	
	const ACTIVE_MODEL_ID = 'wan22';
	
	// Processing options
	let removeBackground = $state(false); // Disabled by default for faster testing
	let pixelateOutput = $state(false); // Disabled by default - only enable if you want pixelation effect
	let pixelSize = $state(2); // Size of each "pixel" (2-8)
	let colorLevels = $state(64); // Color levels (8, 16, 32)
	let canvasPadding = $state(0); // Transparent pixels added equally around each finished frame

	if (browser) {
		try {
			const raw = localStorage.getItem(ANIMATE_STATE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (typeof parsed?.prompt === 'string') prompt = parsed.prompt;
				if (typeof parsed?.duration === 'number') duration = parsed.duration;
				if (typeof parsed?.motionAmount === 'number') motionAmount = parsed.motionAmount;
				if (typeof parsed?.shouldLoop === 'boolean') shouldLoop = parsed.shouldLoop;
				if (typeof parsed?.perfectLoop === 'boolean') perfectLoop = parsed.perfectLoop;
				if ([1, 2, 4].includes(Number(parsed?.seedCount))) seedCount = Number(parsed.seedCount);
				if (typeof parsed?.useWanCanvas === 'boolean') useWanCanvas = parsed.useWanCanvas;
				if (typeof parsed?.staticAssetLock === 'boolean') staticAssetLock = parsed.staticAssetLock;
				if (typeof parsed?.selectedPose === 'string') selectedPose = parsed.selectedPose;
				if (typeof parsed?.showAdvanced === 'boolean') showAdvanced = parsed.showAdvanced;
				if (parsed?.guidanceScale === null || typeof parsed?.guidanceScale === 'number') guidanceScale = parsed.guidanceScale;
				if (parsed?.seed === null || typeof parsed?.seed === 'number') seed = parsed.seed;
				if (typeof parsed?.negativePrompt === 'string') negativePrompt = parsed.negativePrompt;
				if (typeof parsed?.flfDurationSeconds === 'number') flfDurationSeconds = parsed.flfDurationSeconds;
				if (typeof parsed?.flfInferenceSteps === 'number') flfInferenceSteps = parsed.flfInferenceSteps;
				if (typeof parsed?.flfGuidanceScale === 'number') flfGuidanceScale = parsed.flfGuidanceScale;
				if (typeof parsed?.flfGuidanceScale2 === 'number') flfGuidanceScale2 = parsed.flfGuidanceScale2;
				if (typeof parsed?.flfShift === 'number') flfShift = parsed.flfShift;
				if (parsed?.flfSeed === null || typeof parsed?.flfSeed === 'number') flfSeed = parsed.flfSeed;
				if (typeof parsed?.flfNegativePrompt === 'string') flfNegativePrompt = parsed.flfNegativePrompt;
				if (typeof parsed?.useInterpolation === 'boolean') useInterpolation = parsed.useInterpolation;
				if (parsed?.endFrame === null || typeof parsed?.endFrame === 'string') endFrame = parsed.endFrame;
				if (typeof parsed?.frameTargetMode === 'string') frameTargetMode = parsed.frameTargetMode;
				if (typeof parsed?.manualFrameCount === 'number') manualFrameCount = parsed.manualFrameCount;
				if (parsed?.inputLongEdge != null) inputLongEdge = Number(parsed.inputLongEdge) || 1024;
				if (typeof parsed?.removeBackground === 'boolean') removeBackground = parsed.removeBackground;
				if (typeof parsed?.pixelateOutput === 'boolean') pixelateOutput = parsed.pixelateOutput;
				if (typeof parsed?.pixelSize === 'number') pixelSize = parsed.pixelSize;
				if (typeof parsed?.colorLevels === 'number') colorLevels = parsed.colorLevels;
				if (typeof parsed?.canvasPadding === 'number') canvasPadding = parsed.canvasPadding;
			}
		} catch {
			// ignore storage parse errors
		}
	}

	function clampFrameBudget(rawCount) {
		const safe = Number.isFinite(rawCount) ? Math.round(rawCount) : MIN_TARGET_FRAMES;
		return Math.max(MIN_TARGET_FRAMES, Math.min(MAX_TARGET_FRAMES, safe));
	}

	function clampManualFrameCount(rawCount) {
		const safe = Number.isFinite(rawCount) ? Math.round(rawCount) : 16;
		return Math.max(MIN_MANUAL_FRAMES, Math.min(MAX_MANUAL_FRAMES, safe));
	}

	function loadImageDataUrl(dataUrl) {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('Failed to load frame for perfect loop'));
			img.src = dataUrl;
		});
	}


	$effect(() => {
		if (perfectLoop && !shouldLoop) {
			shouldLoop = true;
		}
	});

	$effect(() => {
		if (!browser) return;
		try {
			localStorage.setItem(
				ANIMATE_STATE_KEY,
				JSON.stringify({
					prompt,
					duration,
					motionAmount,
					shouldLoop,
					perfectLoop,
					staticAssetLock,
					selectedPose,
					showAdvanced,
					guidanceScale,
					seed,
					negativePrompt,
					flfDurationSeconds,
					flfInferenceSteps,
					flfGuidanceScale,
					flfGuidanceScale2,
					flfShift,
					flfSeed,
					flfNegativePrompt,
					useInterpolation,
					endFrame,
					frameTargetMode,
					manualFrameCount,
					inputLongEdge,
					removeBackground,
					pixelateOutput,
					pixelSize,
					colorLevels,
					canvasPadding,
					seedCount,
					useWanCanvas
				})
			);
		} catch {
			// ignore storage quota/private mode errors
		}
	});

	let targetFrameCount = $derived.by(() => {
		if (frameTargetMode === 'manual') {
			return clampManualFrameCount(manualFrameCount);
		}
		const base = useInterpolation
			? Math.round(flfDurationSeconds * project.fps)
			: Math.round(duration * project.fps);
		return clampFrameBudget(base);
	});

	let rawEstimatedFrames = $derived.by(() => {
		const seconds = useInterpolation ? flfDurationSeconds : duration;
		return Math.max(1, Math.round(seconds * project.fps));
	});

	function handleFirstFrameUpload(dataUrl) {
		projectStore.update(p => ({ ...p, firstFrame: dataUrl }));
	}
	
	function openPosePicker() {
		// Emit event to show poses in center and switch to poses view
		if (typeof window !== 'undefined') {
			window.dispatchEvent(new CustomEvent('startPosePicking'));
			window.dispatchEvent(new CustomEvent('switchToPoses'));
		}
	}

	function effectiveMotion() {
		const isRunningPreset = selectedPose.startsWith('run_');
		const isIdlePreset = selectedPose === 'bust_idle_peaceful' || selectedPose === 'idle' || selectedPose.startsWith('idle_');
		if (selectedPose === 'idle_battle_ready') return Math.max(82, Math.min(96, Number(motionAmount) || 88));
		if (selectedPose === 'bust_idle_peaceful') return 20;
		if (isIdlePreset) return Math.max(70, Math.min(90, Number(motionAmount) || 82));
		if (isRunningPreset) return Math.max(88, Math.min(118, Number(motionAmount) || 100));
		return motionAmount;
	}

	/** One generation run (one seed): submit → wait → post-process → file. */
	async function runOne({ runSeed, index, total, poseName, referenceForModel, endForRun, finalPrompt, modelForRun, lockedInterpolation, wanInput, totalFrameCount }) {
		const label = total > 1 ? `${poseName} · seed ${runSeed}` : poseName;
		const qid = jobQueue.addJob({ type: 'Animation', kind: 'animation', origin: 'animate', name: label, status: 'processing', message: 'Submitting...' });
		const report = (message) => {
			if (index === 0) progress = { ...progress, status: 'processing', message };
			jobQueue.updateJob(qid, { message });
		};
		try {
			const isRunningPreset = selectedPose.startsWith('run_');
			const effectiveGuidanceScale = isRunningPreset && (guidanceScale == null || guidanceScale < 8) ? 8 : guidanceScale;
			const response = await fetch('/api/generate-animation', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					referenceImage: referenceForModel,
					endImage: endForRun,
					prompt: finalPrompt,
					pose: selectedPose,
					frameCount: totalFrameCount,
					duration,
					motionAmount: effectiveMotion(),
					fps: project.fps,
					loop: shouldLoop || perfectLoop,
					perfectLoop,
					staticAssetMode: staticAssetLock,
					model: modelForRun,
					interpolate: lockedInterpolation,
					guidanceScale: effectiveGuidanceScale,
					seed: runSeed,
					negativePrompt,
					...(lockedInterpolation && {
						flfDurationSeconds, flfInferenceSteps, flfGuidanceScale, flfGuidanceScale2, flfShift,
						flfSeed: runSeed ?? flfSeed, flfNegativePrompt
					})
				})
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Generation failed');
			if (!data.jobId) throw new Error('No jobId returned from server');

			const { videoUrl } = await waitForJob(data.jobId, {
				onProgress: (pr) => {
					if (index === 0) progress = pr;
					jobQueue.updateJob(qid, {
						progress: pr.totalFrames > 0 ? Math.round((pr.currentFrame / pr.totalFrames) * 100) : 0,
						message: pr.message || 'Generating...'
					});
				}
			});

			let frames;
			try {
				frames = await finalizeVideo({
					videoUrl,
					targetFrameCount: totalFrameCount,
					crop: wanInput?.crop,
					original: wanInput?.original,
					loopMode: perfectLoop ? 'perfect' : shouldLoop ? 'pingpong' : 'none',
					removeBackground,
					pixelate: { enabled: pixelateOutput, pixelSize, colorLevels },
					canvasPadding,
					onProgress: report
				});
			} catch (extractError) {
				await completedJobs.addAnimation({ name: `${label} (video only)`, frames: [], videoUrl, pose: selectedPose, fps: project.fps, error: extractError.message });
				throw new Error('Failed to process frames: ' + extractError.message);
			}

			const completedJobId = await completedJobs.addAnimation({ name: label, frames, pose: selectedPose, fps: project.fps, seed: runSeed });
			if (index === 0) {
				projectStore.update((pj) => ({ ...pj, frames, prompt: label }));
				if (typeof window !== 'undefined') {
					window.dispatchEvent(new CustomEvent('animationCompleted'));
					window.dispatchEvent(new CustomEvent('jobsAnimationSelected', { detail: { jobId: completedJobId, label } }));
				}
			}
			jobQueue.completeJob(qid, { frameCount: frames.length });
			return frames;
		} catch (err) {
			jobQueue.failJob(qid, err.message);
			throw err;
		}
	}

	async function generateFrames() {
		if (!project.firstFrame) {
			generationError = 'Reference image is required. Upload your sprite first.';
			return;
		}
		const lockedInterpolation = staticAssetLock ? true : useInterpolation;
		const lockedEndFrame = staticAssetLock ? (endFrame || project.firstFrame) : endFrame;
		if (lockedInterpolation && !lockedEndFrame) {
			generationError = 'End frame is required for interpolation mode. Upload an end frame.';
			return;
		}
		const posePrompt = prompt.trim();
		if (!posePrompt) {
			generationError = 'Enter an animation prompt. It will be sent to the model exactly as typed.';
			return;
		}

		isGenerating = true;
		generationError = null;
		batchErrors = [];
		const totalFrameCount = targetFrameCount;
		progress = { currentFrame: 0, totalFrames: totalFrameCount, status: 'starting', message: 'Preparing input...' };
		const poseName = posePresets.find((pp) => pp.id === selectedPose)?.name || selectedPose;
		projectStore.update((pj) => ({ ...pj, frames: [] }));

		try {
			const normalizedLongEdge = Number(inputLongEdge) || 1024;
			const sourceImage = await clampImageLongEdge(project.firstFrame, normalizedLongEdge);
			const sourceEndImage = lockedInterpolation && lockedEndFrame ? await clampImageLongEdge(lockedEndFrame, normalizedLongEdge) : null;
			const activeChroma = $activeAssetStore?.chromaKeyHex || CHROMA_KEY_HEX;

			// Paint the sprite large on a 16:9 chroma canvas so the model sees detail; crop back later.
			let wanInput = null;
			let referenceForModel = sourceImage;
			const canvasMode = useWanCanvas && !lockedInterpolation;
			if (canvasMode) {
				wanInput = await prepareWanInput(sourceImage, { chromaHex: activeChroma });
				referenceForModel = wanInput.dataUrl;
			}
			const finalPrompt = canvasMode ? buildWanPrompt(posePrompt, activeChroma) : posePrompt;
			// Perfect loop: anchor first and last frame to the same image via Wan 2.7 FLF.
			const modelForRun = perfectLoop && !lockedInterpolation ? 'wan27' : ACTIVE_MODEL_ID;
			const endForRun = lockedInterpolation ? sourceEndImage : perfectLoop ? referenceForModel : null;

			const total = Math.max(1, Math.min(4, Number(seedCount) || 1));
			const seeds = total > 1
				? Array.from({ length: total }, () => Math.floor(Math.random() * 2147483647))
				: [seed];

			const results = await Promise.allSettled(
				seeds.map((runSeed, index) =>
					runOne({ runSeed, index, total, poseName, referenceForModel, endForRun, finalPrompt, modelForRun, lockedInterpolation, wanInput, totalFrameCount })
				)
			);
			const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message || 'Failed');
			batchErrors = failures;
			if (failures.length === results.length) {
				generationError = failures[0];
				progress = { ...progress, status: 'error', message: failures[0] };
			} else {
				const ok = results.length - failures.length;
				progress = { ...progress, status: 'completed', message: total > 1 ? `Done: ${ok}/${total} seeds ready in Jobs.` : 'Done! Frames ready.' };
			}
		} catch (error) {
			generationError = error.message;
			progress = { ...progress, status: 'error', message: error.message };
		} finally {
			isGenerating = false;
		}
	}
</script>

<div class="space-y-3">
	<div class="rounded-lg border border-gray-200 bg-white p-2 space-y-2">
		<div class="flex items-center justify-between">
			<p class="text-xs font-semibold text-gray-700">🖼️ Source Frames</p>
			<label class="flex items-center gap-1 text-xs">
				<input type="checkbox" bind:checked={useInterpolation} class="w-3 h-3" />
				<span>🔀 Start → End</span>
			</label>
		</div>

		<div class="flex gap-2 {useInterpolation ? '' : 'justify-center'}">
			<div class="{useInterpolation ? 'flex-1' : 'w-full'}">
				{#if useInterpolation}
					<p class="text-[10px] text-gray-500 text-center mb-1">Start</p>
				{/if}
				{#if project.firstFrame}
					<div class="relative">
						<img src={project.firstFrame} alt="Start" class="w-full {useInterpolation ? 'aspect-square' : 'h-56'} object-contain rounded-lg border-2 border-blue-400 bg-gray-100" />
						<button class="absolute top-1 right-1 bg-red-500 text-white text-xs w-5 h-5 rounded-full hover:bg-red-600 flex items-center justify-center" onclick={() => projectStore.update(p => ({ ...p, firstFrame: null }))}>×</button>
					</div>
				{:else}
					<div class={useInterpolation ? 'aspect-square' : 'h-56'}>
						<FrameUpload label={useInterpolation ? "Start" : "Upload Sprite"} onUpload={handleFirstFrameUpload} />
					</div>
				{/if}
			</div>

			{#if useInterpolation}
				<div class="flex-1">
					<p class="text-[10px] text-gray-500 text-center mb-1">End</p>
					{#if endFrame}
						<div class="relative">
							<img src={endFrame} alt="End" class="w-full aspect-square object-contain rounded-lg border-2 border-green-400 bg-gray-100" />
							<button class="absolute top-1 right-1 bg-red-500 text-white text-xs w-5 h-5 rounded-full hover:bg-red-600 flex items-center justify-center" onclick={clearEndFrame}>×</button>
						</div>
					{:else}
						<div class="aspect-square">
							<FrameUpload label="End" onUpload={handleEndFrameUpload} />
						</div>
					{/if}
				</div>
			{/if}
		</div>

		{#if !project.firstFrame && savedPoses.poses.length > 0}
			<button class="w-full px-2 py-1.5 text-xs bg-purple-100 text-purple-700 border border-purple-300 rounded hover:bg-purple-200" onclick={openPosePicker}>
				🎭 Use Saved Pose ({savedPoses.poses.length})
			</button>
		{/if}
	</div>

	<!-- Mode: Perfect loops (one button) vs Manual (every knob) -->
	<div class="grid grid-cols-2 gap-1 text-xs">
		<button class="px-2 py-1.5 rounded border {mode === 'perfect' ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}" onclick={() => { mode = 'perfect'; plSave(); }}>✨ Perfect loops</button>
		<button class="px-2 py-1.5 rounded border {mode === 'manual' ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}" onclick={() => { mode = 'manual'; plSave(); }}>🛠️ Manual</button>
	</div>

	{#if mode === 'perfect'}
		<div class="rounded-lg border border-violet-200 bg-violet-50 p-2 space-y-2 text-xs">
			<p class="text-[10px] text-violet-900">Pick the actions, press the button. The app frames the sprite, generates each clip with Wan 2.2, finds the frames that loop seamlessly, keys the background, matches the colours, crops the whole set to one canvas and saves it to your library. Each action is scored; aim for <b>perfect</b> or <b>good</b>.</p>

			<div class="grid grid-cols-2 gap-2">
				<label class="col-span-2">
					<span class="text-[10px] text-violet-900 font-semibold">Who is this? (2–4 features, optional)</span>
					<input type="text" bind:value={plSubject} onchange={plSave} placeholder="a knight in blue armor with a red plume and a round shield" class="w-full mt-0.5 px-2 py-1 border rounded" />
				</label>
				<label>
					<span class="text-[10px] text-violet-900 font-semibold">View</span>
					<select bind:value={plView} onchange={() => { plDefaults(); plSave(); }} class="w-full mt-0.5 px-1 py-1 border rounded">
						<option value="front">Front / as drawn</option>
						<option value="side">Side-scroller (profile →)</option>
					</select>
				</label>
				<label>
					<span class="text-[10px] text-violet-900 font-semibold">Set name</span>
					<input type="text" bind:value={plName} onchange={plSave} placeholder={project.projectName || 'hero'} class="w-full mt-0.5 px-2 py-1 border rounded" />
				</label>
				{#if plView === 'side'}
					<label class="col-span-2 flex items-center gap-1 text-[11px] text-violet-900">
						<input type="checkbox" bind:checked={plReframe} onchange={plSave} class="w-3 h-3" />
						Redraw the sprite in side profile first (+$0.04). Untick if it is already a profile facing right.
					</label>
				{/if}
			</div>

			<div class="space-y-1">
				<div class="flex items-center justify-between">
					<span class="text-[10px] text-violet-900 font-semibold">Actions</span>
					<button class="text-[10px] text-violet-700 underline" onclick={() => { plDefaults(); plSave(); }}>default set</button>
				</div>
				{#each plGroups as group}
					<div class="flex flex-wrap gap-1 items-center">
						<span class="text-[10px] text-violet-700 w-14 shrink-0">{group}</span>
						{#each plSets.filter((p) => p.group === group) as p (p.id)}
							<button class="px-1.5 py-0.5 rounded border text-[10px] {plChecked.has(p.id) ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-violet-100'}" title={p.description} onclick={() => { plToggle(p.id); plSave(); }} disabled={plRunning}>
								{p.name.replace(/^Side - /, '')}
							</button>
						{/each}
					</div>
				{/each}
				<input type="text" bind:value={plCustom} placeholder="…or describe one more action in your own words" class="w-full px-2 py-1 border rounded text-[11px]" disabled={plRunning} />
			</div>

			<button class="w-full px-3 py-2 rounded bg-violet-600 text-white font-semibold hover:bg-violet-700 disabled:bg-gray-400" onclick={runPerfectLoops} disabled={plRunning || !project.firstFrame || (plChecked.size === 0 && !plCustom.trim())}>
				{plRunning ? '⏳ Working…' : `✨ Make ${plChecked.size + (plCustom.trim() ? 1 : 0)} perfect loop${plChecked.size + (plCustom.trim() ? 1 : 0) === 1 ? '' : 's'} · ≈$${plCost.toFixed(2)}`}
			</button>
			{#if !project.firstFrame}<p class="text-[10px] text-violet-700">Upload or pick a sprite above first.</p>{/if}
			{#if plError}<p class="text-[10px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{plError}</p>{/if}

			{#if plProgress && (plRunning || plResults.length)}
				<div class="space-y-1">
					{#if plRunning}<p class="text-[10px] text-violet-900">{plProgress.message || 'Working…'}</p>{/if}
					{#each plProgress.actions || [] as a (a.id)}
						<div class="flex items-center gap-2 bg-white rounded border border-violet-100 px-2 py-1">
							{#if a.thumbnailUrl}<img src={a.thumbnailUrl} alt="" class="w-6 h-6 object-contain" style="image-rendering: pixelated" />{:else}<span class="w-6 h-6 inline-block"></span>{/if}
							<span class="flex-1 truncate">{a.name}</span>
							{#if a.loop}
								<span class="text-[10px] font-mono text-gray-500" title="seam ÷ median frame step">{a.loop.ratio}</span>
								<span class="text-[10px] text-white px-1.5 rounded {PL_VERDICT[a.loop.verdict] || 'bg-gray-500'}">{a.loop.verdict}</span>
							{/if}
							{#if a.touchesEdge}<span class="text-[10px] text-amber-700" title="A limb reached the crop edge in some frame">⚠ edge</span>{/if}
							{#if a.status === 'failed'}<span class="text-[10px] text-red-700" title={a.error}>failed</span>
							{:else if a.status === 'done'}
								<button class="text-[10px] text-violet-700 underline" onclick={() => loadResult(a)}>open</button>
							{:else if a.status !== 'pending'}<span class="text-[10px] text-violet-700">{a.status}…</span>{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if mode === 'manual'}
	<div class="rounded-lg border border-gray-200 bg-white p-2 space-y-2">
		<p class="text-xs font-semibold text-gray-700">🎬 Animation Setup</p>
		<div class="hidden">
			<span class="text-xs font-medium text-gray-700">Type:</span>
			<select bind:value={selectedPose} onchange={() => {
				const preset = posePresets.find((pose) => pose.id === selectedPose);
				if (preset && selectedPose !== 'custom') prompt = preset.description;
			}} class="flex-1 px-2 py-1 text-xs border border-gray-300 rounded bg-white">
				{#each posePresets as pose}
					<option value={pose.id}>{pose.name}</option>
				{/each}
			</select>
		</div>
		<input type="text" bind:value={prompt} placeholder="Raw prompt, e.g. subtle idle breathing and one blink" class="w-full px-2 py-1 text-xs border border-gray-300 rounded" />
		<p class="text-[10px] text-gray-500">Sent to Wan exactly as typed.</p>
		<button class="w-full px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded border border-gray-300 transition-colors" onclick={() => showAdvanced = !showAdvanced}>
			{showAdvanced ? '▼ Hide' : '▶ Show'} animation settings
		</button>

		<div class={showAdvanced ? 'flex items-center gap-2 text-xs' : 'hidden'}>
			<span class="text-gray-700 font-medium">📐 Max Input:</span>
			<select bind:value={inputLongEdge} onchange={(e) => inputLongEdge = Number(e.target.value)} class="px-2 py-1 border border-gray-300 rounded bg-white text-xs">
				<option value={640}>640px</option>
				<option value={768}>768px</option>
				<option value={1024}>1024px</option>
				<option value={1280}>1280px</option>
				<option value={1536}>1536px</option>
			</select>
			<span class="text-[10px] text-gray-500">Caps source long edge before generation</span>
		</div>

		<div class={showAdvanced ? 'grid grid-cols-1 md:grid-cols-3 gap-2 text-xs' : 'hidden'}>
			<div class="p-2 rounded border bg-gray-50">
				<p class="text-[10px] text-gray-500">⏱️ Duration</p>
				<p class="font-medium">{useInterpolation ? flfDurationSeconds : duration}s</p>
				{#if useInterpolation}
					<input type="range" min="1" max="10" step="0.5" bind:value={flfDurationSeconds} class="w-full h-1" />
				{:else}
					<input type="range" min="1" max="10" step="0.5" bind:value={duration} class="w-full h-1" />
				{/if}
			</div>
			<div class="p-2 rounded border bg-gray-50">
				<p class="text-[10px] text-gray-500">🎞️ FPS</p>
				<p class="font-medium">{project.fps} fps</p>
				<select value={project.fps} onchange={(e) => updateFPS(Number(e.target.value))} class="w-full text-[10px] border rounded px-1 py-0.5">
					<option value={6}>6 fps</option>
					<option value={8}>8 fps</option>
					<option value={10}>10 fps</option>
					<option value={12}>12 fps</option>
				</select>
			</div>
			<div class="p-2 rounded border bg-gray-50">
				{#if !useInterpolation}
					<p class="text-[10px] text-gray-500">💨 Motion</p>
					<p class="font-medium">{motionAmount < 80 ? 'Low' : motionAmount < 140 ? 'Med' : 'High'}</p>
					<input type="range" min="50" max="180" bind:value={motionAmount} class="w-full h-1" />
				{:else}
					<p class="text-[10px] text-gray-500">🧠 FLF Steps</p>
					<p class="font-medium">{flfInferenceSteps} steps</p>
					<input type="range" min="1" max="30" step="1" bind:value={flfInferenceSteps} class="w-full h-1" />
				{/if}
			</div>
		</div>

		<div class={showAdvanced ? 'grid grid-cols-2 md:grid-cols-5 gap-2 text-xs' : 'hidden'}>
			<label class="flex items-center gap-1"><input type="checkbox" bind:checked={shouldLoop} class="w-3 h-3" />🔁 Loop</label>
			<label class="flex items-center gap-1 text-purple-700"><input type="checkbox" bind:checked={perfectLoop} class="w-3 h-3" />♾️ Perfect</label>
			<label class="flex items-center gap-1 text-gray-600"><input type="checkbox" bind:checked={removeBackground} class="w-3 h-3" />🧽 Remove BG</label>
			<label class="flex items-center gap-1 text-gray-600"><input type="checkbox" bind:checked={pixelateOutput} class="w-3 h-3" />🧊 Pixelate</label>
			<label class="flex items-center gap-1 text-amber-700" title="For buildings/scenery. Locks object position and orientation."><input type="checkbox" bind:checked={staticAssetLock} class="w-3 h-3" />📌 Static Lock</label>
		</div>
	</div>

	<div class="flex flex-wrap items-center gap-2 text-[11px] text-gray-700">
		<label class="flex items-center gap-1" title="Generate several takes with different seeds and pick the best in Jobs">
			🎲 Seeds
			<select bind:value={seedCount} class="px-1 py-0.5 border rounded text-[11px]">
				<option value={1}>1</option>
				<option value={2}>2</option>
				<option value={4}>4</option>
			</select>
		</label>
		<label class="flex items-center gap-1" title="Paint the sprite large on a 832×480 chroma canvas, then crop back. Much sharper output.">
			<input type="checkbox" bind:checked={useWanCanvas} class="w-3 h-3" />🖼 Canvas prep
		</label>
		<span class="ml-auto text-gray-500">≈ ${(costPerClipUsd * (perfectLoop && !useInterpolation ? 8 : 1) * Math.max(1, Number(seedCount) || 1)).toFixed(2)} per run</span>
	</div>
	{#if batchErrors.length > 0 && batchErrors.length < Number(seedCount)}
		<p class="text-[10px] text-amber-700">{batchErrors.length} of {seedCount} seeds failed: {batchErrors[0]}</p>
	{/if}

	<!-- Primary action kept high in layout -->
	<button
		class="w-full px-3 py-2 text-sm text-white rounded disabled:bg-gray-400 disabled:cursor-not-allowed font-medium {useInterpolation ? 'bg-indigo-500 hover:bg-indigo-600' : 'bg-blue-500 hover:bg-blue-600'}"
		onclick={generateFrames}
		disabled={isGenerating || !project.firstFrame || (useInterpolation && !endFrame)}
	>
		{isGenerating ? '⏳ Generating...' : useInterpolation ? '⚡ Interpolate Frames' : '🚀 Generate Animation'}
	</button>

	<div class={showAdvanced ? 'rounded-lg border border-gray-200 bg-white p-2 space-y-2' : 'hidden'}>
		<p class="text-xs font-semibold text-gray-700">🧮 Frame Planner</p>
		<div class="text-[11px] bg-blue-50 border border-blue-200 rounded px-2 py-1 text-blue-800">
			⏱️ {useInterpolation ? flfDurationSeconds : duration}s × 🎞️ {project.fps} fps = <strong>{rawEstimatedFrames}</strong> raw frames
		</div>
		<div class="flex items-center justify-between text-xs">
			<span class="font-medium text-gray-700">🎯 Output Frames</span>
			<div class="flex items-center gap-3">
				<label class="flex items-center gap-1"><input type="radio" name="frameTargetMode" value="auto" bind:group={frameTargetMode} class="w-3 h-3" />Auto</label>
				<label class="flex items-center gap-1"><input type="radio" name="frameTargetMode" value="manual" bind:group={frameTargetMode} class="w-3 h-3" />Manual</label>
			</div>
		</div>
		{#if frameTargetMode === 'manual'}
			<div class="grid grid-cols-[1fr_auto] gap-2 items-center">
				<input type="range" min={MIN_MANUAL_FRAMES} max={MAX_MANUAL_FRAMES} step="1" bind:value={manualFrameCount} class="w-full h-1" />
				<input type="number" min={MIN_MANUAL_FRAMES} max={MAX_MANUAL_FRAMES} step="1" bind:value={manualFrameCount} onchange={() => manualFrameCount = clampManualFrameCount(manualFrameCount)} class="w-20 px-1 py-0.5 border rounded text-xs" />
			</div>
		{/if}
		<p class="text-[11px] text-gray-600">
			Final target: <strong>{targetFrameCount}</strong> frames
			{#if frameTargetMode === 'auto'}
				<span class="text-gray-400"> (auto range {MIN_TARGET_FRAMES}-{MAX_TARGET_FRAMES})</span>
			{/if}
		</p>
	</div>
	
	<!-- Pixelation Settings (when enabled) -->
	{#if pixelateOutput}
		<div class={showAdvanced ? 'flex items-center gap-3 text-[10px] bg-amber-50 border border-amber-200 rounded p-2' : 'hidden'}>
			<span class="text-amber-700 font-medium">Pixel Art:</span>
			<label class="flex items-center gap-1">
				<span class="text-gray-600">Size:</span>
				<select bind:value={pixelSize} class="px-1 py-0.5 border rounded text-[10px]">
					<option value={2}>2px (fine)</option>
					<option value={4}>4px</option>
					<option value={6}>6px</option>
					<option value={8}>8px (chunky)</option>
				</select>
			</label>
			<label class="flex items-center gap-1">
				<span class="text-gray-600">Colors:</span>
				<select bind:value={colorLevels} class="px-1 py-0.5 border rounded text-[10px]">
					<option value={8}>8 (retro)</option>
					<option value={16}>16</option>
					<option value={32}>32</option>
					<option value={64}>64 (smooth)</option>
				</select>
			</label>
		</div>
	{/if}

	<!-- Transparent canvas space is applied after extraction, never sent to the video model. -->
	<div class={showAdvanced ? 'flex items-center gap-2 text-[10px] bg-violet-50 border border-violet-200 rounded p-2' : 'hidden'}>
		<label class="flex items-center gap-2">
			<span class="font-medium text-violet-800">Canvas Padding</span>
			<input type="number" min="0" max="2048" step="1" bind:value={canvasPadding} class="w-16 px-1 py-0.5 border rounded text-[10px]" />
			<span class="text-gray-600">px on every side · transparent</span>
		</label>
	</div>

	<!-- Advanced Settings Toggle -->
	<button
		class="hidden"
		onclick={() => showAdvanced = !showAdvanced}
	>
		{showAdvanced ? '▼' : '▶'} Advanced Settings {showAdvanced ? '(Hide)' : '(Show)'}
	</button>

	<!-- Advanced Settings Panel -->
	{#if showAdvanced}
		<div class="space-y-2 p-2 bg-gray-50 border border-gray-200 rounded text-xs">
			
			{#if useInterpolation}
				<!-- ═══ FLF-SPECIFIC SETTINGS (Interpolation Mode) ═══ -->
				<p class="text-[10px] text-indigo-600 font-medium mb-1">⚡ Wan 2.2 First/Last-Frame Interpolation</p>
				<p class="text-[9px] text-gray-500 -mt-1">Uses the start and end images to guide the animation's opening and closing frame.</p>

				<!-- Duration -->
				<div>
					<label class="block text-[10px] text-gray-600 mb-1">
						Duration: <strong>{flfDurationSeconds}s</strong>
						<span class="text-gray-400">(0.5–10s, longer = more frames)</span>
					</label>
					<input type="range" min="0.5" max="10" step="0.5" bind:value={flfDurationSeconds} class="w-full h-1" />
				</div>

				<!-- Inference Steps -->
				<div>
					<label class="block text-[10px] text-gray-600 mb-1">
						Inference Steps: <strong>{flfInferenceSteps}</strong>
						<span class="text-gray-400">(1–30, higher = better quality, slower)</span>
					</label>
					<input type="range" min="1" max="30" step="1" bind:value={flfInferenceSteps} class="w-full h-1" />
				</div>

				<!-- Guidance Scales (dual) -->
				<div class="grid grid-cols-2 gap-2">
					<div>
						<label class="block text-[10px] text-gray-600 mb-1">
							Guidance (High Noise): <strong>{flfGuidanceScale}</strong>
						</label>
						<input type="range" min="0" max="10" step="0.5" bind:value={flfGuidanceScale} class="w-full h-1" />
					</div>
					<div>
						<label class="block text-[10px] text-gray-600 mb-1">
							Guidance (Low Noise): <strong>{flfGuidanceScale2}</strong>
						</label>
						<input type="range" min="0" max="10" step="0.5" bind:value={flfGuidanceScale2} class="w-full h-1" />
					</div>
				</div>
				<p class="text-[9px] text-gray-400 -mt-1">Higher guidance = stricter adherence to prompt at each noise stage</p>

				<!-- Shift (Scheduler) -->
				<div>
					<label class="block text-[10px] text-gray-600 mb-1">
						Scheduler Shift: <strong>{flfShift}</strong>
						<span class="text-gray-400">(1–10, controls noise schedule)</span>
					</label>
					<input type="range" min="1" max="10" step="0.5" bind:value={flfShift} class="w-full h-1" />
				</div>

				<!-- Seed -->
				<div>
					<label class="block text-[10px] text-gray-600 mb-1">
						Seed: {flfSeed ?? 'Random'}
					</label>
					<div class="flex items-center gap-2">
						<input type="number" bind:value={flfSeed} placeholder="Random" class="flex-1 px-2 py-1 text-xs border rounded" />
						<button class="px-2 py-0.5 text-[10px] bg-gray-200 rounded hover:bg-gray-300" onclick={() => flfSeed = null}>Random</button>
					</div>
				</div>

				<!-- FLF Negative Prompt -->
				<div>
					<label class="block text-[10px] text-gray-600 mb-1">
						Extra Negative Prompt <span class="text-gray-400">(added to model's default negatives)</span>
					</label>
					<textarea
						bind:value={flfNegativePrompt}
						placeholder="e.g., jittery, static, extra limbs..."
						class="w-full px-2 py-1 text-xs border rounded resize-none"
						rows="2"
					></textarea>
				</div>

				<!-- Reset FLF to Defaults -->
				<button
					class="w-full px-2 py-1 text-[10px] bg-gray-200 text-gray-600 rounded hover:bg-gray-300"
					onclick={() => { flfDurationSeconds = 5; flfInferenceSteps = 8; flfGuidanceScale = 1; flfGuidanceScale2 = 1; flfShift = 8; flfSeed = null; flfNegativePrompt = ''; }}
				>
					↺ Reset FLF to Defaults
				</button>

				<!-- Quality Presets -->
				<div class="flex gap-1 flex-wrap">
					<span class="text-[10px] text-gray-500 mr-1">Presets:</span>
					<button
						class="px-2 py-0.5 text-[10px] bg-green-100 text-green-700 rounded hover:bg-green-200"
					onclick={() => { flfDurationSeconds = 2; flfInferenceSteps = 8; flfGuidanceScale = 1; flfGuidanceScale2 = 1; flfShift = 8; }}
					title="Quick generation, fewer frames"
					>⚡ Fast</button>
					<button
						class="px-2 py-0.5 text-[10px] bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
					onclick={() => { flfDurationSeconds = 5; flfInferenceSteps = 8; flfGuidanceScale = 1; flfGuidanceScale2 = 1; flfShift = 8; }}
					title="Model defaults — recommended starting point"
					>⚖️ Balanced</button>
					<button
						class="px-2 py-0.5 text-[10px] bg-purple-100 text-purple-700 rounded hover:bg-purple-200"
					onclick={() => { flfDurationSeconds = 5; flfInferenceSteps = 12; flfGuidanceScale = 2; flfGuidanceScale2 = 2; flfShift = 8; }}
					title="Slightly more refined, a bit slower"
					>💎 Quality</button>
					<button
						class="px-2 py-0.5 text-[10px] bg-amber-100 text-amber-700 rounded hover:bg-amber-200"
					onclick={() => { flfDurationSeconds = 5; flfInferenceSteps = 16; flfGuidanceScale = 3; flfGuidanceScale2 = 3; flfShift = 8; }}
					title="Maximum steps — slowest, may improve detail"
					>👑 Max</button>
				</div>

			{:else}
				<!-- ═══ STANDARD I2V SETTINGS ═══ -->
				<p class="text-[10px] text-gray-500 font-medium mb-2">Fine-tune generation for better accuracy and loops</p>
				
				<!-- Guidance Scale -->
				<div>
					<label class="block text-[10px] text-gray-600 mb-1">
						Guidance Scale: {guidanceScale || 'Auto (7.5)'}
						<span class="text-gray-400">(Higher = more prompt adherence, 3-15)</span>
					</label>
					<div class="flex items-center gap-2">
						<input 
							type="range" 
							min="3" 
							max="15" 
							step="0.5" 
							bind:value={guidanceScale}
							class="flex-1 h-1"
						/>
						<button
							class="px-2 py-0.5 text-[10px] bg-gray-200 rounded hover:bg-gray-300"
							onclick={() => guidanceScale = null}
							title="Reset to model default"
						>
							Reset
						</button>
					</div>
				</div>

				<!-- Seed -->
				<div>
					<label class="block text-[10px] text-gray-600 mb-1">
						Seed: {seed || 'Random'}
						<span class="text-gray-400">(Same seed = reproducible results)</span>
					</label>
					<div class="flex items-center gap-2">
						<input
							type="number"
							bind:value={seed}
							placeholder="Random"
							class="flex-1 px-2 py-1 text-xs border rounded"
						/>
						<button
							class="px-2 py-0.5 text-[10px] bg-gray-200 rounded hover:bg-gray-300"
							onclick={() => seed = null}
							title="Use random seed"
						>
							Random
						</button>
					</div>
				</div>

				<!-- Negative Prompt -->
				<div>
					<label class="block text-[10px] text-gray-600 mb-1">
						Negative Prompt
						<span class="text-gray-400">(Things to avoid - added to default negatives)</span>
					</label>
					<textarea
						bind:value={negativePrompt}
						placeholder="e.g., jittery, flickering, color shift..."
						class="w-full px-2 py-1 text-xs border rounded resize-none"
						rows="2"
					></textarea>
					<p class="text-[9px] text-gray-400 mt-0.5">
						Default negatives: blurry, distorted, inconsistent, flickering, jittery, pixelated artifacts
					</p>
				</div>

				<!-- Loop Tips -->
				{#if shouldLoop}
					<div class="p-2 bg-blue-50 border border-blue-200 rounded">
						<p class="text-[10px] text-blue-800 font-medium mb-1">💡 Loop Tips:</p>
						<ul class="text-[9px] text-blue-700 space-y-0.5 list-disc list-inside">
							<li>Lower motion amount (30-60) for smoother loops</li>
							<li>Use seed for reproducible loop attempts</li>
							<li>Higher guidance (8-12) helps maintain consistency</li>
							<li>Ping-pong loop button creates seamless back-and-forth</li>
						</ul>
					</div>
				{/if}
			{/if}
		</div>
	{/if}

	<!-- Progress / Error -->
	{#if isGenerating && progress.status !== 'idle'}
		<div class="text-xs">
			<div class="flex justify-between text-gray-600 mb-1">
				<span>{progress.message || 'Processing...'}</span>
			</div>
			<div class="w-full bg-gray-200 rounded-full h-1.5">
				<div class="bg-blue-500 h-1.5 rounded-full transition-all" style="width: {progress.totalFrames > 0 ? (progress.currentFrame / progress.totalFrames) * 100 : 10}%"></div>
			</div>
		</div>
	{/if}

	{#if generationError}
		<p class="text-xs text-red-600 bg-red-50 px-2 py-1 rounded">{generationError}</p>
	{/if}
	{/if}
</div>

