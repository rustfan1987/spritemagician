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
	{ id: 'custom', name: 'Custom', group: 'Custom', description: '' }
];

/** The set offered for one-click character batches. */
export const CHARACTER_ACTION_IDS = ['idle', 'walk_in_place_clean', 'run_in_place_clean', 'jump', 'attack', 'cast', 'hit', 'death'];

export function presetById(id) {
	return POSE_PRESETS.find((p) => p.id === id) || null;
}
