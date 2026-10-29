# Notes for AI agents working in this repo

Sprite Magician is a local-first Electron/SvelteKit app. There are no accounts and
no cloud database: everything lives under `~/SpriteMagician` (override with
`SPRITEMAGICIAN_DATA_DIR`). API keys are in `<dataDir>/settings.json`.

## Automating "sprite → set of looping animations"

This is the most common agent task. The whole recipe is implemented and
documented in **`scripts/animate.mjs`**. Read its header comment first; it
records what worked, what failed, and why. Short version:

```bash
# server must be running: npm run dev   (or the Electron app)
node scripts/animate.mjs --image path/to/sprite.png \
  --actions "jump,hit,run_in_place_clean,walk_in_place_clean,attack_claw_swipe" \
  --name hero --seed 7 --replace
```

Output: one `.anim.json` per action in the library folder `Characters/`
(visible in the app's file tree immediately), a preview GIF per action under
`out/anim/<name>/`, and `results.json` with seeds and source video URLs.
Cost on Replicate: about $0.05 per action (wan-2.2-i2v-fast) plus one $0.002
background-removal call if the source PNG has no alpha.

### The checklist an agent should follow

1. **Look at the sprite** (use an image viewer tool). Note: does it have a
   weapon? A hat? Is it already transparent? Pick presets that match. Never
   send a prompt that mentions props the sprite does not have; the model will
   invent them (an unarmed scarecrow grew a staff from the stock `attack`
   preset — use `attack_claw_swipe` for unarmed characters).
2. **Run one action first** (`--actions jump`), build a contact sheet and look
   at it before spending on the rest:
   ```bash
   ffmpeg -y -i out/anim/hero/hero-jump.gif -vf "scale=150:-1,tile=8x3:padding=3:color=0x777777" sheet.png
   ```
   Things to check: limbs clipped at the edge (framing margin too small),
   sideways drift (window/re-centre not working), frozen poses (static-frame
   filter), colour spill (chroma key), invented props (prompt).
3. **Fix the pipeline, not the output.** If something is wrong, change the
   script (framing, prompt, window selection) and re-run; do not hand-edit
   frames. Keep the seed fixed while iterating so you compare like with like.
   A different seed is the right move only when the video itself is bad.
4. **Run the batch with `--replace`** so re-runs overwrite earlier entries in
   the library instead of piling up duplicates.
5. **Review every sheet**, then report: which actions are good, which need a
   different preset/seed, and the total spend (`GET /api/usage`).

### Preset ids

See `src/lib/animation/presets.js`. Cycles (loop by nature): `idle*`, `walk*`,
`run*`. One-shots that the model usually returns to the start pose:
`jump`, `jump_double`, `hit*`, `attack*`, `cast*`. `death*` does not loop.
`"id=custom text"` sends your own description under a preset's file name.

### Known limits (as of 2026-10-28)

- Wan 2.2 renders a painterly/3D-ish version of pixel art. For crisp pixel
  output run the frames through the app's pixelate pass (Animate panel → Pixel
  art) or add quantisation to the script; not done yet.
- Clips are always ~5 s (81 frames @ 16 fps). Cycle windows take 24 consecutive
  native frames (1.5 s), played back at 12 fps.
- Accounts with under $5 Replicate credit are throttled to one request at a
  time; `createPrediction` in `src/lib/server/replicate.js` retries 429s.
- The browser UI does the same steps in `src/lib/animation/pipeline.js` and
  `src/lib/components/GenerationPanel.svelte`; keep the two in sync when you
  change framing or loop logic.

## Other useful entry points

- `src/routes/api/*` — every operation the UI can do is a JSON endpoint on
  the local server; agents can drive the app without a browser.
- `GET /api/library?all=1`, `POST /api/library {action: ...}` — file tree.
- `POST /api/generate-animation` + `GET /api/generation-progress?jobId=` — video.
- `POST /api/save-animation` then `POST /api/library {action:'createFile'}` —
  how an animation becomes a library item.
- `GET /api/usage` — estimated spend so far.
