/** Decode an animated image and sample one loop at evenly spaced times. */
export async function extractAnimatedImageFrames(url, mimeType, numFrames) {
	if (!Number.isInteger(numFrames) || numFrames < 1 || numFrames > 120) {
		throw new Error('Frame count must be an integer between 1 and 120');
	}
	if (typeof ImageDecoder === 'undefined' || !(await ImageDecoder.isTypeSupported(mimeType))) {
		throw new Error(`Animated ${mimeType} decoding is unavailable in this browser`);
	}
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch animation: ${response.status}`);
	const data = await response.arrayBuffer();
	const decoder = new ImageDecoder({ data, type: mimeType, preferAnimation: true });
	try {
		await decoder.tracks.ready;
		const count = decoder.tracks.selectedTrack?.frameCount || 0;
		if (!count) throw new Error('Animation contains no decodable frames');
		if (count > 10000) throw new Error('Animation has too many frames to extract');
		const durations = [];
		for (let i = 0; i < count; i++) {
			const { image } = await decoder.decode({ frameIndex: i });
			try { durations.push(image.duration > 0 ? image.duration : 100000); }
			finally { image.close(); }
		}
		const total = durations.reduce((a, b) => a + b, 0);
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Unable to create frame canvas');
		const frames = [];
		let index = 0, end = durations[0];
		for (let i = 0; i < numFrames; i++) {
			const time = i * total / numFrames;
			while (time >= end && index < count - 1) end += durations[++index];
			const { image } = await decoder.decode({ frameIndex: index });
			try {
				canvas.width = image.displayWidth;
				canvas.height = image.displayHeight;
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(image, 0, 0);
				frames.push(canvas.toDataURL('image/png'));
			} finally { image.close(); }
		}
		return frames;
	} finally { decoder.close(); }
}
