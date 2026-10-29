import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	ssr: {
		// Bundle every server dependency into build/ so the Electron package
		// does not need node_modules at runtime.
		noExternal: true,
		// sharp is a native module (libvips); it cannot be bundled and is
		// shipped in node_modules instead (see electron-builder.yml).
		external: ['sharp']
	}
});
