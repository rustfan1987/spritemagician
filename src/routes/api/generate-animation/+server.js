/**
 * Image-to-Video generation with multiple model options
 * 
 * Models (Replicate — standard I2V):
 * - Wan 2.2 Fast: Cheapest, fast I2V
 * - LTX Video: Fast alternative
 * - Hailuo 2.3: Best quality
 * - SVD: Slow but reliable
 * 
 * Interpolation — First/Last Frame to Video:
 * - lucataco/wan-2.2-first-last-frame (Replicate, same API key)
 * 
 * Flow:
 * 1. Send the reference image as a Replicate-supported data URL
 * 2. Generate video using selected model
 * 3. Return video URL for client to extract frames
 */

import { json } from '@sveltejs/kit';
import { env } from '$lib/server/env.js';
import { setProgress, clearProgress, setProgressOwner } from '$lib/utils/generationProgress.js';
import { resolveForProvider } from '$lib/server/localFiles.js';
import { waitForPrediction, toReplicateInput, createPrediction } from '$lib/server/replicate.js';
import { getPreference } from '$lib/server/settings.js';
import { runVideoWorkflow, uploadImage as comfyUpload, snapFrameCount, loadWorkflow as loadComfyWorkflow } from '$lib/server/comfyui.js';
import { approxJsonBytes, enforceRateLimit } from '$lib/server/security.js';
import {
	beginIdempotentRequest,
	completeIdempotentRequest,
	failIdempotentRequest,
	makeRequestHash,
	recordUsageEvent
} from '$lib/server/requestTracking.js';

// Available Replicate models (standard I2V)
const MODELS = {
	wan27: {
		name: 'Wan 2.7 I2V (Recommended)',
		version: 'wan-video/wan-2.7-i2v',
		speed: 'medium',
		isModelPath: true
	},
	wan22: {
		name: 'Wan 2.2 Fast (Cheapest)',
		version: 'wan-video/wan-2.2-i2v-fast',
		speed: 'fast',
		isModelPath: true
	},
	ltxv: {
		name: 'LTX Video (Fast)',
		version: '8c47da666861d081eeb4d1261853087de23923a268a69b63febdf5dc1dee08e4',
		speed: 'fast'
	},
	hailuo: {
		name: 'Hailuo 2.3 (Quality)',
		version: '23a02633b5a44780345a59d4d43f8bd510efa239c56f08f29639ff24fa6615e1',
		speed: 'fast'
	},
	live2d: {
		name: 'Video-01 Live (2D)',
		version: '7574e16b8f1ad52c6332ecb264c0f132e555f46c222255a738131ec1bb614092',
		speed: 'fast'
	},
	wan25: {
		name: 'Wan 2.5 I2V',
		version: '1b29bbbbfdbc25bba2294de3acd2b58b82e5b623f183880cdb37d76133d80f00',
		speed: 'medium'
	},
	svd: {
		name: 'SVD (Expensive)',
		version: 'stability-ai/stable-video-diffusion:3f0457e4619daac51203dedb472816fd4af51f3149fa7a9e0b5ffcf1b8172438',
		speed: 'slow'
	}
};

// Native first/last-frame conditioning gives quiet idles a real spatial anchor.
async function runReplicateWan27(jobId, firstFrame, lastFrame, prompt, frameCount, fps, negativePrompt, seed) {
	const duration = Math.max(2, Math.min(5, Math.ceil(frameCount / Math.max(1, fps))));
	const input = {
		first_frame: firstFrame,
		...(lastFrame ? { last_frame: lastFrame } : {}),
		prompt,
		negative_prompt: negativePrompt,
		resolution: '720p',
		duration,
		// Prompt expansion can invent a performance from an otherwise quiet idle.
		enable_prompt_expansion: false,
		...(seed != null ? { seed } : {})
	};
	setProgress(jobId, { currentFrame: 0, totalFrames: frameCount, status: 'processing', message: `Starting Wan 2.7 anchored I2V (${duration}s)...` });
	let result = await createPrediction({ model: 'wan-video/wan-2.7-i2v', input });
	result = await waitForPrediction(result, {
		maxMs: 480_000,
		onTick: (p, ms) => setProgress(jobId, { currentFrame: Math.min(Math.floor(ms / 8000), frameCount - 1), totalFrames: frameCount, status: 'processing', message: `Wan 2.7: ${p.status}... (${Math.round(ms / 1000)}s)` })
	});
	return result.output;
}

// Replicate FLF model for interpolation
const FLF_MODEL_VERSION = '003fd8a38ff17cb6022c3117bb90f7403cb632062ba2b098710738d116847d57';

function requireRawPrompt(value) {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error('An animation prompt is required.');
	}
	return value;
}


// ═══════════════════════════════════════════════════════════════════════════════
// Replicate — WAN 2.2 First/Last Frame interpolation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run WAN 2.2 First-Last-Frame interpolation via Replicate.
 * Full parameter support per model schema:
 *   start_image, end_image, prompt, negative_prompt, duration_seconds,
 *   num_inference_steps, guidance_scale (high noise), guidance_scale_2 (low noise),
 *   shift (scheduler), seed
 */
async function runReplicateInterpolation(jobId, startImageDataUrl, endImageDataUrl, prompt, frameCount, fps, flfOptions = {}) {
	const REPLICATE_API_TOKEN = env.REPLICATE_API_TOKEN;
	if (!REPLICATE_API_TOKEN) {
		throw new Error('Replicate is not configured. Add your REPLICATE_API_TOKEN in Settings.');
	}

	const rawPrompt = requireRawPrompt(prompt);
	console.log('[FLF] Raw prompt:', rawPrompt);

	// Use the model's own default negative prompt (Chinese). Only add user extras if provided.
	const MODEL_DEFAULT_NEGATIVE = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走,过曝，';
	const userNeg = flfOptions.negativePrompt || '';
	const finalNegativePrompt = userNeg ? `${MODEL_DEFAULT_NEGATIVE} ${userNeg}` : MODEL_DEFAULT_NEGATIVE;

	// Resolve FLF-specific parameters — using exact model defaults (matching working examples)
	// Source: https://replicate.com/lucataco/wan-2.2-first-last-frame schema
	const durationSeconds = flfOptions.durationSeconds ?? 5;       // model default: 5
	const numInferenceSteps = flfOptions.numInferenceSteps ?? 8;   // model default: 8
	const guidanceScale = flfOptions.guidanceScale ?? 1;           // model default: 1
	const guidanceScale2 = flfOptions.guidanceScale2 ?? 1;         // model default: 1
	const shift = flfOptions.shift ?? 8;                           // model default: 8
	const seed = flfOptions.seed;                                  // nullable integer

	console.log('[FLF] Parameters:', { durationSeconds, numInferenceSteps, guidanceScale, guidanceScale2, shift, seed: seed ?? 'random' });

	// Replicate accepts HTTP URLs and data URLs for file inputs. Keeping the
	// data URLs keeps everything local until the provider request.
	const startUrl = startImageDataUrl;
	const endUrl = endImageDataUrl;

	// 2. Submit prediction with full parameter set
	setProgress(jobId, { currentFrame: 0, totalFrames: frameCount, status: 'processing', message: `Submitting to Replicate FLF (${durationSeconds}s, ${numInferenceSteps} steps)...` });

	const inputPayload = {
		start_image: startUrl,
		end_image: endUrl,
		prompt: rawPrompt,
		negative_prompt: finalNegativePrompt,
		duration_seconds: durationSeconds,
		num_inference_steps: numInferenceSteps,
		guidance_scale: guidanceScale,
		guidance_scale_2: guidanceScale2,
		shift: shift,
		...(seed != null && { seed: seed })
	};

	console.log('[FLF] Full input payload:', { ...inputPayload, start_image: '(url)', end_image: '(url)' });

	const submitRes = { ok: true, json: async () => createPrediction({ version: FLF_MODEL_VERSION, input: inputPayload }) };

	const prediction = await submitRes.json();
	console.log('[FLF] Prediction started:', prediction.id);

	// 3. Poll for completion
	setProgress(jobId, { currentFrame: 0, totalFrames: frameCount, status: 'processing', message: 'Replicate FLF: Queued...' });

	const result = await waitForPrediction(prediction, {
		maxMs: 300_000,
		onTick: (p, ms) => setProgress(jobId, {
			currentFrame: Math.min(Math.floor(ms / 6000), frameCount - 1),
			totalFrames: frameCount,
			status: 'processing',
			message: `Replicate FLF: ${p.status}... (${Math.round(ms / 1000)}s)`
		})
	});
	const videoUrl = result.output;
	if (!videoUrl) {
		console.error('[FLF] No output in result:', JSON.stringify(result).substring(0, 500));
		throw new Error('Replicate FLF returned no output');
	}
	console.log('[FLF] Completed, video URL:', videoUrl);
	return videoUrl;
}


// ═══════════════════════════════════════════════════════════════════════════════
// Main async processor
// ═══════════════════════════════════════════════════════════════════════════════

async function processAnimationAsync(jobId, referenceImage, prompt, frameCount, motionAmount = 127, fps = 8, modelId = 'wan22', endImage = null, loop = false, perfectLoop = false, guidanceScale = null, seed = null, negativePrompt = null, flfOptions = {}, staticAssetMode = false, wanOpts = {}) {
	let isInterpolation = !!endImage;
	if (staticAssetMode && !isInterpolation) {
		// Hard-lock fallback: interpolate from the same frame when no end frame is provided.
		endImage = referenceImage;
		isInterpolation = true;
	}
	
	const rawPrompt = requireRawPrompt(prompt);
	
	// Default negative prompt to avoid common issues
	const staticLockNegative = staticAssetMode
		? ', camera motion, camera pan, camera orbit, object rotation, object drift, translation, wobble, jitter, shake, perspective shift, framing change'
		: '';
	const defaultNegativePrompt = `blurry, distorted, inconsistent, flickering, jittery, pixelated artifacts, color bleeding, ghosting, double image, duplicate limbs, extra appendages, deformed, bad anatomy, low quality, mouth movement, talking, jaw movement, lip sync, character scaling, size changes, zoom in, zoom out, character growing, character shrinking, inconsistent character size, explosion effects, random fire bursts, particle storms, magical flashes, dramatic lens flare, screen-space energy bursts, shockwave VFX, debris bursts, blast rings${staticLockNegative}`;
	const finalNegativePrompt = negativePrompt 
		? `${defaultNegativePrompt}, ${negativePrompt}`
		: defaultNegativePrompt;
	
	try {
		if (modelId === 'wan27') {
			const videoUrl = await runReplicateWan27(jobId, referenceImage, endImage, rawPrompt, frameCount, fps, finalNegativePrompt, seed);
			setProgress(jobId, { currentFrame: frameCount, totalFrames: frameCount, status: 'completed', message: 'Wan 2.7 video generated! Extracting frames...', videoUrl, loop: true, frames: [] });
			setTimeout(() => clearProgress(jobId), 120000);
			return;
		}
		// ── Interpolation Mode (Start → End frame via Replicate FLF) ────────
		if (isInterpolation) {
			console.log('[Animation] Interpolation → Replicate WAN 2.2 FLF');
			const interpolationNegative = [finalNegativePrompt, flfOptions?.negativePrompt].filter(Boolean).join(', ');
			const videoUrl = await runReplicateInterpolation(
				jobId,
				referenceImage,
				endImage,
				rawPrompt,
				frameCount,
				fps,
				{ ...flfOptions, negativePrompt: interpolationNegative }
			);

			setProgress(jobId, {
				currentFrame: frameCount,
				totalFrames: frameCount,
				status: 'completed',
				message: 'Video generated! Extracting frames...',
				videoUrl: videoUrl,
				loop: true,
				frames: []
			});

			setTimeout(() => clearProgress(jobId), 120000);
			return;
		}

		// ── Local ComfyUI backend (user-supplied workflow) ───────────────────
		if (getPreference('videoBackend') === 'comfyui') {
			loadComfyWorkflow(); // seeds the bundled template on first use and fails early if it is missing
			setProgress(jobId, { currentFrame: 0, totalFrames: frameCount, status: 'processing', message: 'Uploading to ComfyUI...' });
			const imageName = await comfyUpload(referenceImage);
			const seconds = Math.max(1, Math.min(7.5, frameCount / Math.max(1, fps)));
			const videoUrl = await runVideoWorkflow({
				vars: {
					IMAGE: imageName,
					PROMPT: rawPrompt,
					SEED: seed ?? Math.floor(Math.random() * 2147483647),
					NUM_FRAMES: snapFrameCount(seconds * 16),
					FPS: 16
				},
				onTick: (status) => setProgress(jobId, { currentFrame: 0, totalFrames: frameCount, status: 'processing', message: `ComfyUI: ${status}...` })
			});
			setProgress(jobId, { currentFrame: frameCount, totalFrames: frameCount, status: 'completed', message: 'ComfyUI video ready! Extracting frames...', videoUrl, loop: true, frames: [] });
			setTimeout(() => clearProgress(jobId), 120000);
			return;
		}

		// ── Standard I2V via Replicate ──────────────────────────────────────
		const model = MODELS[modelId] || MODELS.wan22;

		// SVD uses Replicate API
		if (modelId === 'svd') {
			console.log('Using Replicate SVD API');
			
			setProgress(jobId, {
				currentFrame: 0,
				totalFrames: frameCount,
				status: 'processing',
				message: 'Uploading image for SVD...'
			});

			const imageUrl = await toReplicateInput(referenceImage);

			setProgress(jobId, {
				currentFrame: 0,
				totalFrames: frameCount,
				status: 'processing',
				message: 'Starting SVD generation...'
			});

			const svdVersion = MODELS.svd.version;
			const svdFrames = Math.min(25, Math.max(14, frameCount));
			console.log(`SVD generating ${svdFrames} frames for ${frameCount} requested`);
			
			const svdMotion = motionAmount ? Math.max(1, Math.min(255, motionAmount)) : 127;
			const svdInput = {
				input_image: imageUrl,
				motion_bucket_id: svdMotion,
				fps: fps,
				num_frames: svdFrames,
				...(seed !== null && { seed: seed })
			};
			
			const prediction = await createPrediction({ version: svdVersion, input: svdInput });
			console.log('SVD prediction started:', prediction.id);

			const svdResult = await waitForPrediction(prediction, {
				maxMs: 600_000,
				onTick: (p, ms) => setProgress(jobId, {
					currentFrame: Math.min(Math.floor(ms / 10000), frameCount - 1),
					totalFrames: frameCount,
					status: 'processing',
					message: `SVD generating... (${Math.round(ms / 1000)}s)`
				})
			});
			const videoUrl = svdResult.output;

			setProgress(jobId, {
				currentFrame: frameCount,
				totalFrames: frameCount,
				status: 'completed',
				message: 'Video generated! Extracting frames...',
				videoUrl: videoUrl,
				loop: true,
				frames: []
			});

			setTimeout(() => clearProgress(jobId), 120000);
			return;
		}

		// Replicate accepts data URLs directly, so local animation does not need
		// an extra upload before submitting the prediction.
		setProgress(jobId, {
			currentFrame: 0,
			totalFrames: frameCount,
			status: 'processing',
			message: 'Preparing reference image...'
		});

		const imageUrl = referenceImage;

		setProgress(jobId, {
			currentFrame: 0,
			totalFrames: frameCount,
			status: 'processing',
			message: `Starting ${model.name}...`
		});

		// Build input based on model
		let input;
		
		if (modelId === 'hailuo') {
			// Hailuo supports guidance_scale
			const hailuoGuidance = guidanceScale !== null ? guidanceScale : 7.5;
			input = {
				prompt: rawPrompt,
				negative_prompt: finalNegativePrompt,
				first_frame_image: imageUrl,
				guidance_scale: hailuoGuidance,
				...(seed !== null && { seed: seed })
			};
		} else if (modelId === 'ltxv') {
			// LTX Video supports guidance_scale and motion_scale
			const ltxGuidance = guidanceScale !== null ? guidanceScale : 7.5;
			const ltxMotion = motionAmount ? Math.max(0.1, Math.min(2.0, motionAmount / 127)) : 1.0;
			input = {
				input_image: imageUrl,
				prompt: rawPrompt,
				negative_prompt: finalNegativePrompt,
				num_frames: Math.min(65, frameCount * 3),
				guidance_scale: ltxGuidance,
				motion_scale: ltxMotion,
				...(seed !== null && { seed: seed })
			};
		} else if (modelId === 'live2d') {
			// Live2D supports guidance_scale
			const live2dGuidance = guidanceScale !== null ? guidanceScale : 7.5;
			input = {
				prompt: rawPrompt,
				negative_prompt: finalNegativePrompt,
				first_frame_image: imageUrl,
				guidance_scale: live2dGuidance,
				...(seed !== null && { seed: seed })
			};
		} else if (modelId === 'wan22') {
			// Wan 2.2 is trained at 16 fps. Generate natively and let the client
			// subsample to the sprite's fps; asking for 8 fps here produces slow,
			// drifting motion. 81 frames (~5 s) is the model's sweet spot.
			const WAN_NATIVE_FPS = 16;
			const seconds = Math.max(1, Math.min(7.5, frameCount / Math.max(1, fps)));
			const wanFrames = Math.min(121, Math.max(81, Math.round(seconds * WAN_NATIVE_FPS)));
			input = {
				prompt: rawPrompt,
				image: imageUrl,
				num_frames: wanFrames,
				frames_per_second: WAN_NATIVE_FPS,
				resolution: '480p',
				// loopAnchor: condition the LAST frame on the input image too, so the
				// clip ends where it started (cheap seamless loops, same price).
				...(wanOpts.loopAnchor && { last_image: imageUrl }),
				// sample_shift (default 12 on Replicate): lower = closer to the input
				// image / less motion, higher = more motion. 8–12 is the useful band.
				...(Number.isFinite(wanOpts.sampleShift) && { sample_shift: wanOpts.sampleShift }),
				...(seed !== null && { seed: seed })
			};
		} else if (modelId === 'wan25') {
			// WAN 2.5 supports additional parameters
			const wan25Motion = motionAmount ? Math.max(1, Math.min(255, motionAmount)) : 127;
			input = {
				prompt: rawPrompt,
				negative_prompt: finalNegativePrompt,
				image: imageUrl,
				max_area: '832x480',
				fast_mode: 'Disabled',
				motion_bucket_id: wan25Motion,
				...(seed !== null && { seed: seed })
			};
		} else {
			input = {
				prompt: rawPrompt,
				first_frame_image: imageUrl
			};
		}
		
		console.log(`${model.name} params:`, { fps, motionAmount, frameCount, modelId });

		let prediction;
		try {
			prediction = model.isModelPath
				? await createPrediction({ model: model.version, input })
				: await createPrediction({ version: model.version, input });
		} catch (error) {
			console.error(`${model.name} API error:`, error.message);
			throw new Error(`${model.name} API error: ${error.message}`);
		}
		console.log(`${model.name} prediction started:`, prediction.id);
		
		const result = await waitForPrediction(prediction, {
			intervalMs: model.speed === 'fast' ? 1500 : 2000,
			maxMs: model.speed === 'fast' ? 180_000 : 600_000,
			onTick: (p, ms) => setProgress(jobId, {
				currentFrame: Math.min(Math.floor(ms / 10000), frameCount - 1),
				totalFrames: frameCount,
				status: 'processing',
				message: `${model.name}: ${p.status}... (${Math.round(ms / 1000)}s)`
			})
		});

		const videoUrl = result.output;
		console.log(`${model.name} completed, video URL:`, videoUrl);
		
		setProgress(jobId, {
			currentFrame: frameCount,
			totalFrames: frameCount,
			status: 'completed',
			message: 'Video generated! Extracting frames...',
			videoUrl: videoUrl,
			loop: true,
			frames: []
		});

		setTimeout(() => clearProgress(jobId), 120000);

	} catch (error) {
		console.error('Animation generation error:', error);
		setProgress(jobId, {
			currentFrame: 0,
			totalFrames: frameCount,
			status: 'error',
			message: error.message
		});
		setTimeout(() => clearProgress(jobId), 10000);
	}
}

export async function POST({ request, locals }) {
	const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
		setProgressOwner(jobId, locals.user.uid);
	let idempotencyKey = null;
	let requestHash = null;
	let payloadBytes = 0;

	try {
		if (!locals.user) {
			return json({ error: 'Authentication required' }, { status: 401 });
		}

		const { 
			referenceImage, endImage, prompt, pose, frameCount, motionAmount, fps, loop, interpolate, 
			perfectLoop, guidanceScale, seed, negativePrompt,
			staticAssetMode,
			// Wan 2.2 extras
			loopAnchor, sampleShift,
			// FLF-specific parameters (for interpolation mode)
			flfDurationSeconds, flfInferenceSteps, flfGuidanceScale, flfGuidanceScale2, flfShift, flfSeed, flfNegativePrompt
		} = await request.json();
		const payload = {
			referenceImage, endImage, prompt, pose, frameCount, motionAmount, fps, loop, interpolate,
			perfectLoop, guidanceScale, seed, negativePrompt, staticAssetMode, loopAnchor, sampleShift,
			flfDurationSeconds, flfInferenceSteps, flfGuidanceScale, flfGuidanceScale2, flfShift, flfSeed, flfNegativePrompt
		};
		idempotencyKey = request.headers.get('Idempotency-Key')?.trim() || null;
		requestHash = makeRequestHash(payload);
		payloadBytes = approxJsonBytes(payload);
		if (payloadBytes > 8 * 1024 * 1024) {
			return json({ error: 'Request payload too large' }, { status: 413 });
		}
		const rate = enforceRateLimit({
			uid: locals.user.uid,
			routeKey: 'generate-animation',
			maxRequests: 10,
			windowMs: 60_000
		});
		if (!rate.allowed) {
			return json(
				{ error: 'Rate limit exceeded. Please try again shortly.' },
				{ status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } }
			);
		}
		if (idempotencyKey) {
			const idempotency = await beginIdempotentRequest({
				uid: locals.user.uid,
				routeKey: 'generate-animation',
				idempotencyKey,
				requestHash
			});
			if (idempotency.status === 'replay') {
				return json(idempotency.responseBody, { status: idempotency.responseStatus });
			}
			if (idempotency.status === 'processing') {
				return json(
					{ error: 'A request with this Idempotency-Key is already processing.' },
					{ status: 409 }
				);
			}
			if (idempotency.status === 'conflict') {
				return json(
					{ error: 'Idempotency-Key already used with different payload.' },
					{ status: 409 }
				);
			}
		}

		if (!referenceImage) {
			return json({ error: 'Reference image is required. Upload an image first.' }, { status: 400 });
		}
		
		if (interpolate && !endImage) {
			return json({ error: 'End image is required for interpolation mode' }, { status: 400 });
		}

		const numFrames = frameCount || 8;
		const isInterpolation = interpolate && !!endImage;
		const modelId = 'wan22';
		const selectedModel = MODELS[modelId] || MODELS.wan22;

		// All modes require Replicate
		if (!env.REPLICATE_API_TOKEN) {
			return json({ error: 'Replicate is not configured. Add your REPLICATE_API_TOKEN in Settings.', code: 'MISSING_KEY', key: 'REPLICATE_API_TOKEN' }, { status: 412 });
		}

		const displayName = selectedModel.name;

		setProgress(jobId, {
			currentFrame: 0,
			totalFrames: numFrames,
			status: 'starting',
			message: isInterpolation ? 'Interpolating first and last frames with Wan 2.2...' : `Initializing ${selectedModel.name}...`
		});
		
		// Build FLF options object for interpolation mode
		const flfOptions = isInterpolation ? {
			durationSeconds: flfDurationSeconds ?? undefined,
			numInferenceSteps: flfInferenceSteps ?? undefined,
			guidanceScale: flfGuidanceScale ?? undefined,
			guidanceScale2: flfGuidanceScale2 ?? undefined,
			shift: flfShift ?? undefined,
			seed: flfSeed ?? undefined,
			negativePrompt: flfNegativePrompt || negativePrompt || null
		} : {};

		processAnimationAsync(
			jobId, 
			referenceImage, 
			prompt, 
			numFrames, 
			motionAmount || 127, 
			fps || 8, 
			modelId, 
			isInterpolation ? endImage : null,
			loop || false,
			perfectLoop || false,
			guidanceScale || null,
			seed || null,
			negativePrompt || null,
			flfOptions,
			!!staticAssetMode,
			{ loopAnchor: !!loopAnchor, sampleShift: sampleShift === undefined || sampleShift === null ? undefined : Number(sampleShift) }
		);

		const responseBody = {
			jobId,
			status: 'started',
			model: displayName,
			interpolate: isInterpolation
		};
		if (idempotencyKey) {
			await completeIdempotentRequest({
				uid: locals.user.uid,
				routeKey: 'generate-animation',
				idempotencyKey,
				requestHash,
				responseStatus: 200,
				responseBody
			});
		}
		await recordUsageEvent({
			uid: locals.user.uid,
			routeKey: 'generate-animation',
			provider: 'replicate',
			statusCode: 200,
			requestBytes: payloadBytes,
			metadata: {
				modelId: String(modelId || 'wan22'),
				interpolate: !!isInterpolation,
				frameCount: Number(numFrames) || 0
			}
		});
		return json(responseBody);

	} catch (error) {
		console.error('API error:', error);
		if (idempotencyKey && requestHash && locals.user?.uid) {
			try {
				await failIdempotentRequest({
					uid: locals.user.uid,
					routeKey: 'generate-animation',
					idempotencyKey,
					requestHash,
					errorMessage: error.message
				});
			} catch {
				// best effort
			}
		}
		if (locals.user?.uid) {
			await recordUsageEvent({
				uid: locals.user.uid,
				routeKey: 'generate-animation',
				provider: 'replicate',
				success: false,
				statusCode: 500,
				requestBytes: payloadBytes,
				metadata: { error: String(error.message || 'unknown').slice(0, 200) }
			});
		}
		return json({ error: error.message }, { status: 500 });
	}
}
