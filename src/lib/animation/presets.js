/**
 * Animation presets. Each description is a short action phrase: image-to-video
 * models follow one clear instruction far better than a paragraph, and the
 * framing/background clause is appended automatically (see buildWanPrompt).
 *
 * AI AGENTS: match the preset to what the sprite actually has. Presets that
 * say "weapon" make the model invent one for unarmed characters (use
 * attack_claw_swipe). Cycles (idle/walk/run) are sampled as consecutive
 * frames; one-shots (jump/hit/attack/cast) are sampled evenly across the clip.
 * scripts/animate.mjs decides that from the id/description keywords.
 */
export const POSE_PRESETS = [
	{ id: 'bust_idle_peaceful', name: 'Bust - Peaceful Idle (Locked)', group: 'Idle', description: 'Chest-up bust, locked framing. Only one gentle breath in the shoulders and one slow blink. Mouth closed, head still, no body sway' },
	{ id: 'idle', name: 'Idle - Classic', group: 'Idle', description: 'Idle loop in place: feet planted, tiny knee flex, small breathing bob, slight weight shift, occasional blink' },
	{ id: 'idle_soft_breath', name: 'Idle - Soft Breath', group: 'Idle', description: 'Very subtle idle breathing loop, gentle chest rise and fall, minimal knee flex, no stepping' },
	{ id: 'idle_alive_hero', name: 'Idle - Alive Hero', group: 'Idle', description: 'Alive idle loop: breathing, slight torso sway, shallow knee bend, small hand adjustments, no stepping' },
	{ id: 'idle_lantern_sway', name: 'Idle - Lantern Sway', group: 'Idle', description: 'Idle while holding a lantern: gentle breathing and sway, lantern swings slightly on a delay' },
	{ id: 'idle_battle_ready', name: 'Idle - Battle Ready', group: 'Idle', description: 'Combat idle: shallow bounce, knees compress and release each beat, guard arms make small active motions' },
	{ id: 'cast', name: 'Cast Spell - Classic', group: 'Cast', description: 'Spellcasting loop: clear hand and arm casting gesture, anticipation then release, small glow only at the hands' },
	{ id: 'cast_charge_release', name: 'Cast Spell - Charge + Release', group: 'Cast', description: 'Spell cast: hands gather at chest, brief hold, deliberate release forward, recover to ready stance' },
	{ id: 'cast_channel_loop', name: 'Cast Spell - Channel Loop', group: 'Cast', description: 'Continuous channeling loop with repeated hand and torso rhythm, minimal local effects' },
	{ id: 'cast_one_hand_sigil', name: 'Cast Spell - One-Hand Sigil', group: 'Cast', description: 'One hand traces a compact sigil in the air, quick snap release, clean recovery' },
	{ id: 'attack', name: 'Attack - Classic', group: 'Attack', description: 'Single attack: short anticipation, decisive weapon swing, follow-through, quick return to guard' },
	{ id: 'attack_quick_slash', name: 'Attack - Quick Slash', group: 'Attack', description: 'Fast slash with minimal wind-up, rapid strike arc, crisp impact, immediate reset' },
	{ id: 'attack_heavy_strike', name: 'Attack - Heavy Strike', group: 'Attack', description: 'Heavy strike: deep wind-up, strong body torque, committed hit, heavy follow-through, recover' },
	{ id: 'attack_claw_swipe', name: 'Attack - Claw Swipe (unarmed)', group: 'Attack', description: 'Unarmed claw swipe: short wind-up, one fast forward swipe with the open hand, body leans in, recover to stance. No weapons' },
	{ id: 'attack_combo_two_hit', name: 'Attack - Combo 2-Hit', group: 'Attack', description: 'Two-hit combo: first strike fast, second strike broader and heavier, recover to ready pose' },
	{ id: 'walk', name: 'Walking - Classic', group: 'Walk', description: 'Walk cycle in place, side view, legs alternate stride, arms counter-swing, repeatable loop' },
	{ id: 'walk_in_place_clean', name: 'Walking - In Place Clean', group: 'Walk', description: 'Clean in-place walk cycle, steady cadence, stable torso, no drift' },
	{ id: 'walk_sneak', name: 'Walking - Sneak', group: 'Walk', description: 'Sneaking walk in place: short careful steps, lowered stance, restrained arms, alert head' },
	{ id: 'walk_heavy_march', name: 'Walking - Heavy March', group: 'Walk', description: 'Heavy march in place, grounded footfalls, slight upper-body recoil each step, firm arm swing' },
	{ id: 'run_in_place_clean', name: 'Running - In Place Clean', group: 'Run', description: 'Run cycle in place: alternating leg cadence, arms counter-swing, slight forward lean, stable head' },
	{ id: 'run_sprint', name: 'Running - Sprint', group: 'Run', description: 'Sprint in place with strong knee drive and leg extension, powerful arm pump, compact torso' },
	{ id: 'run_heavy_charge', name: 'Running - Heavy Charge', group: 'Run', description: 'Heavy charge run in place, grounded footfalls with recoil, armored momentum, stable upper body' },
	{ id: 'jump', name: 'Jump - In Place', group: 'Jump', description: 'Jump in place: quick crouch, launch straight up, arms rise, brief hang at the apex, land with a knee bend and return to standing' },
	{ id: 'jump_double', name: 'Jump - Double Hop', group: 'Jump', description: 'Two quick hops in place, light landings, arms loose, feet return to the same spot' },
	{ id: 'hit', name: 'Take Damage - Classic', group: 'Hit', description: 'Hit reaction: body recoils backward, torso arches, head snaps back, feet planted, quick recover' },
	{ id: 'hit_light_flinch', name: 'Take Damage - Light Flinch', group: 'Hit', description: 'Light flinch: short torso and shoulder recoil, immediate regain of balance' },
	{ id: 'hit_heavy_stagger', name: 'Take Damage - Heavy Stagger', group: 'Hit', description: 'Heavy stagger: strong backward recoil through chest and hips, brief unstable stagger, delayed recovery' },
	{ id: 'hit_magic_shock', name: 'Take Damage - Magic Shock', group: 'Hit', description: 'Magic shock: sudden jerk then brief limb tremor, subtle aftershock, recover' },
	{ id: 'death', name: 'Death - Classic', group: 'Death', description: 'Death: knees weaken, body collapses to the ground with weight, final still pose' },
	{ id: 'death_forward_collapse', name: 'Death - Forward Collapse', group: 'Death', description: 'Death with forward collapse, posture folds, controlled fall, settles motionless' },
	{ id: 'death_backward_fall', name: 'Death - Backward Fall', group: 'Death', description: 'Death with backward recoil, stagger, full backward fall, final stillness' },
	{ id: 'death_arcane_dissolve', name: 'Death - Arcane Dissolve', group: 'Death', description: 'Arcane death: brief freeze, posture collapses while a subtle local dissolve effect plays' },
	// ── Side-scroller set (profile view, character faces RIGHT) ───────────────
	// Use with a profile sprite (see /api/reframe-sprite). Motion words follow the
	// Wan 2.2 guidance that worked in testing: one subject, concrete body
	// mechanics with speed and direction, an explicit end state, no scene talk.
	{ id: 'side_idle', name: 'Side - Idle', group: 'Side-scroller', description: 'Profile view facing right. Idle breathing loop: slow chest rise and fall, slight knee flex, head steady, feet planted, then back to the exact starting pose', side: true },
	{ id: 'side_walk', name: 'Side - Walk', group: 'Side-scroller', description: 'Profile view facing right. Walks in place at a steady, relaxed pace: legs alternate full strides, arms swing opposite to the legs, torso upright, feet return to the starting position', side: true },
	{ id: 'side_run', name: 'Side - Run', group: 'Side-scroller', description: 'Profile view facing right. Runs in place with brisk, even cadence: knees drive high, arms pump, slight forward lean, head level, stays on the same spot', side: true },
	{ id: 'side_jump', name: 'Side - Jump', group: 'Side-scroller', description: 'Profile view facing right. Crouches quickly, jumps straight up with arms rising, hangs at the top, lands softly with bent knees and stands back up in the exact starting pose', side: true },
	{ id: 'side_hit', name: 'Side - Take Damage', group: 'Side-scroller', description: 'Profile view facing right. Takes a hit from the front: flinches, the head whips back to the left, eyes squeeze shut, shoulders hunch and the body bends backward, stumbles half a step to the left, then straightens up into the starting pose. Does not attack, no punching, no kicking', side: true },
	{ id: 'side_attack', name: 'Side - Attack (unarmed)', group: 'Side-scroller', description: 'Profile view facing right. Winds up briefly, then swipes the right hand forward in a fast arc toward the right, body leans into the strike, then returns to the starting pose. No weapons', side: true },
	{ id: 'side_attack_weapon', name: 'Side - Attack (weapon)', group: 'Side-scroller', description: 'Profile view facing right. Raises the weapon, swings it forward in a fast arc toward the right, follows through, then returns to the starting guard pose', side: true },
	{ id: 'side_death', name: 'Side - Death', group: 'Side-scroller', description: 'Profile view facing right. Knees buckle, body folds forward and collapses to the ground toward the right, settles completely still', side: true },
	{ id: 'custom', name: 'Custom', group: 'Custom', description: '' }
];

/** The set offered for one-click character batches. */
export const CHARACTER_ACTION_IDS = ['idle', 'walk_in_place_clean', 'run_in_place_clean', 'jump', 'attack', 'cast', 'hit', 'death'];

/** Side-scroller presets, in the order a character batch should run them. */
export const SIDE_ACTION_IDS = ['side_idle', 'side_walk', 'side_run', 'side_jump', 'side_hit', 'side_attack'];

export function presetById(id) {
	return POSE_PRESETS.find((p) => p.id === id) || null;
}
