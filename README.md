# Sprite Magician

A local-first desktop app for generating, editing and animating game sprites with AI models.
No account, no cloud database. Your sprites live in a folder on your own disk and you bring
your own API keys.

## Features

- **Generate** sprites and character sheets from prompts and reference images
- **Edit** with AI inpainting, background removal, upscaling and pixelation
- **Animate** stills into frame sequences and sprite sheets, with GIF / MP4 / sprite-sheet export
- **3D pipeline** (experimental): generate a model, place rig markers, export a Blender payload
- **Local library**: a real folder tree on disk, visible in Explorer / Finder and in the app

## Quick start (desktop app)

Download the installer for your OS from the Releases page, install, launch, then open
**Settings** (top right) and paste your Replicate API token.

Your data lives in `~/SpriteMagician` (your home folder) or wherever `SPRITEMAGICIAN_DATA_DIR` points.

## Run from source

Requires Node.js 20 or newer.

```bash
git clone https://github.com/rustfan1987/spritemagician.git
cd spritemagician
npm install
npm run dev
```

Open http://localhost:5173, click **Settings** and enter your keys.
Data is stored in `~/SpriteMagician` in both modes.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Production build of the SvelteKit app into `build/` |
| `npm start` | Run the production build as a plain local web server |
| `npm run electron:dev` | Build, then launch the Electron desktop window |
| `npm run electron:build` | Build installers into `dist/` with electron-builder |

## Batch animations from the command line

`scripts/animate.mjs` turns one sprite into a set of looping animations (jump, hit, run,
walk, attack, …) without touching the UI. It needs the app running and `ffmpeg` on your PATH:

```bash
node scripts/animate.mjs --image "static/Example images/image.png" \n  --actions "jump,hit,run_in_place_clean,walk_in_place_clean,attack_claw_swipe" --name scarecrow --seed 7
```

Add `--view side` for side-scroller sets (the sprite is redrawn in profile first), or `--generate "<prompt>"` to
make the source character from text. Results land in the library folder `Characters/` plus preview GIFs in `out/anim/<name>/`.
The script header and [AGENTS.md](AGENTS.md) explain every step and the pitfalls.

## API keys

| Key | Needed for |
| --- | --- |
| `REPLICATE_API_TOKEN` | **Required.** Sprite generation, upscaling, background removal, video models |
| `GEMINI_API_KEY` | Optional. Design chat, character sheets, image edits |
| `OPENAI_API_KEY` | Optional. Alternative image editor and prompt helpers |
| `RUNPOD_API_KEY` + endpoint IDs | Optional, advanced. Only if you deploy the custom workers in `runpod/` |

Keys entered in Settings are saved to `<data dir>/settings.json` on your machine. Environment
variables (see `.env.example`) work as a fallback for terminal use. You are billed directly by
each provider.

## Run Wan 2.2 on your own GPU (free, optional)

Video generation can run locally through [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
instead of Replicate. A ready-made workflow for **Wan 2.2 TI2V 5B** ships with the app; it
runs on a 12 GB NVIDIA card (8 GB works with `--lowvram`, slowly).

1. Install ComfyUI and update it to a 2025-08 or newer build (needed for the Wan 2.2 nodes).
2. Download the three model files from
   [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged)
   into ComfyUI's `models/` folder:

   | File | Goes in |
   |---|---|
   | `wan2.2_ti2v_5B_fp16.safetensors` | `models/diffusion_models/` |
   | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `models/text_encoders/` |
   | `wan2.2_vae.safetensors` | `models/vae/` |

3. Start ComfyUI (it listens on `http://127.0.0.1:8188`).
4. In Sprite Magician open **Settings → App → Video backend** and choose **ComfyUI**.

The first local run copies the bundled workflow to `<data dir>/workflows/wan-i2v.json`. Edit
that file to change resolution, steps, or swap in the 14B model; the app only needs the
`{{IMAGE}}`, `{{PROMPT}}`, `{{SEED}}`, `{{NUM_FRAMES}}` and `{{FPS}}` placeholders to stay
in place. To use a different graph, build it in ComfyUI, export with **Save (API format)**,
put the placeholders in, and save it over that file.

Everything else (sprite generation, upscaling, background removal) still uses Replicate.

## How data is stored

```
<data dir>/
  settings.json        API keys and preferences
  library/             Your asset tree (what you see in the app)
    Characters/
    Creatures/
    ...
    .projects/         Animation project frames
    .animations/       Raw .anim.json files before they are filed
    .thumbs/           Thumbnails
  db/                  Small JSON indexes (files.json, jobs.json, projects.json, ...)
```

Files you drop into `library/` by hand are picked up automatically when the app regains focus,
and any file you delete in Explorer disappears from the tree. Right-click a file → Show in folder.

## Project layout

```
src/routes/            SvelteKit pages and /api endpoints
src/lib/components/    UI panels (generation, edit, animation, file tree, settings, ...)
src/lib/server/        Local storage (library.js, localFiles.js, db.js), settings, providers
src/lib/library/       Client-side library API used by the UI
electron/              Desktop shell (main.cjs)
runpod/                Optional self-hosted GPU workers
BlenderSpriteSheetTool/ Blender add-on and Godot importer for sprite sheets
```

## Contributing

Issues and pull requests are welcome. Please do not commit API keys or service-account files.

## License

MIT. See [LICENSE](LICENSE).
