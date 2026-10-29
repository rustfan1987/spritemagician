# Notes for AI agents working in this repo

Sprite Magician is a local-first Electron/SvelteKit app. There are no accounts and
no cloud database: everything lives under `~/SpriteMagician` (override with
`SPRITEMAGICIAN_DATA_DIR`). API keys are in `<dataDir>/settings.json`.

## Automating "sprite → set of looping animations"

This is the most common agent task. The whole recipe is implemented and
documented in **`scripts/animate.mjs`**. Read its header comment first; it
records what worked, what failed, and why. Short version (side-scroller set):

```bash
# server must be running: npm run dev   (or the Electron app)
node scripts/animate.mjs \
  --generate "full body anime girl adventurer game character, short teal hair, red scarf, white jacket, standing in a strict side profile view facing right, neutral standing pose, whole body visible, flat solid lime green background, no text" \
  --view side --subject "an anime girl with short teal hair, a red scarf, a white jacket, black shorts and brown boots" \
  --actions side_walk,side_run,side_jump,side_hit,side_attack --name hero --seed 7 --replace
```

Output: one `.anim.json` per action in the library folder `Characters/`
(visible in the app's file tree immediately), all cropped to the same canvas,
a preview GIF per action under `out/anim/<name>/`, and `results.json`.
Cost on Replicate: about $0.05 per action (wan-2.2-i2v-fast), $0.003 for a
generated source, $0.04 for a reframe, $0.002 for one background removal.

### The checklist an agent should follow

1. **Look at the sprite** (use an image viewer tool). Weapon? Hat? Already
   transparent? Already a profile? Write the `--subject` line from what you
   see (2–4 identifying features). Pick presets that match; never mention
   props the sprite does not have.
2. **Run one action first** and read its `loop check` line (ratio ≤ 1 is a
   perfect seam; the script also writes `seam-<action>.png`, last 3 frames |
   first 3). Build a contact sheet too and look at both before spending on
   the rest:
   ```bash
   ffmpeg -y -i out/anim/hero/hero-side_walk.gif -vf "scale=100:-1,tile=12x4:padding=3:color=0x777777" sheet.png
   ```
   Check: limbs at the edge (buffer), sideways drift, frozen poses, colour
   drift, invented props, and whether the seam frames are continuous.
3. **Fix the pipeline, not the output.** Change the script (framing, prompt,
   loop method) and re-run; videos are cached per seed so re-processing is
   free. Keep the seed fixed while iterating. Change the seed only when the
   VIDEO itself is bad (a frozen pose, a wrong action).
4. **Run the batch with `--replace`** so re-runs overwrite earlier entries.
5. **Review every sheet and seam**, then report: which actions are good,
   which need a different preset/seed, and the total spend (`GET /api/usage`).

### Loops, in one paragraph

One-shots (jump, hit, attack) are generated with `last_image` = the input, so
the clip ends on the start pose and the whole clip is the loop. Cycles (walk,
run, idle) must NOT be anchored; the script finds the two best-matching frames
a stride or two apart (measured after re-centring, relative to the clip's own
frame step) and loops between them at native 16 fps. Every action then gets a
loop check: seam change ÷ median frame step, with the verdict in
`results.json` and the saved `.anim.json` metadata (`loopCheck`). Colours are matched
back to the source, and the whole set is cropped to one union box so nothing
is cut off and every action shares a canvas.

### Preset ids

See `src/lib/animation/presets.js`. Side-scroller set (profile sprite, faces right): side_idle, side_walk,
side_run, side_jump, side_hit, side_attack, side_attack_weapon, side_death.
Front view: cycles idle*, walk*, run*; one-shots jump, jump_double, hit*,
attack*, cast*. death* does not loop.
`"id=custom text"` sends your own description under a preset's file name.

### Routes added for automation

- `POST /api/text-to-image` — FLUX schnell, Replicate key only.
- `POST /api/reframe-sprite` — FLUX Kontext: side / back / front / three-quarter view of a sprite.
- `POST /api/generate-animation` extras: `loopAnchor` (last_image = input), `sampleShift`.
- Export panel → "Crop to animation bounds" (`src/lib/utils/animationBounds.js`).
- Export panel → "Loop check" seam ratio + seam strip (`src/lib/utils/loopQuality.js`, shared with the script).

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
