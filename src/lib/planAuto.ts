/**
 * What a plan draws for you the moment it finishes, and what it leaves for you
 * to press.
 *
 * THE PROBLEM. `plan_storyboard` queued reference sheets, storyboard panels
 * and a voice clip per speaking character unconditionally — one gate,
 * `plan_refs`, that nothing in the wizard ever sent. The reasoning was sound
 * and is written down in CLAUDE.md: the references measure under a dollar
 * against ~$20 for the render, so the expensive thing to gate is the render.
 *
 * What that costs is the REVIEW. A one-shot with a model pick that cannot
 * render — an image row whose node pack the engine never installed, say —
 * spends every one of those jobs before a single sheet has been looked at,
 * and on a laptop the bill is not money, it is the afternoon. Measured on a
 * real local run: 118 failed jobs, of which 7 were a real fault and 111 were
 * the cascade behind it, all queued before the storyboard had been read.
 *
 * So the wizard asks. Everything is OFF by default — the storyboard is what
 * you came to read, and the cast & world and storyboard steps already carry
 * the buttons that draw the rest when you are ready.
 *
 * Pure so `node --test` reaches it: every rule below is a case in
 * `planAuto.test.ts` rather than something you find out by planning an
 * episode.
 */

/** The three things a plan can do on your behalf. */
export type AutoKey = "sheets" | "panels" | "voices";

export interface AutoStep {
  id: AutoKey;
  label: string;
  /** what turning it ON spends, in one line under the switch */
  blurb: string;
  /** the step whose own button does this when it is off */
  later: string;
  /** ids that must be on for this one to mean anything */
  needs?: readonly AutoKey[];
}

/**
 * IN LADDER ORDER, and the dependency is real rather than tidy: a panel is
 * composed OVER the cast's face plates and the location's master, so one
 * drawn with no sheets on file is the invented-faces failure those anchors
 * exist to end. `llm.py` refuses the same combination with a log line, so a
 * hand-written payload gets the same answer.
 */
export const AUTO_STEPS: readonly AutoStep[] = [
  { id: "sheets", label: "Reference sheets", later: "Cast & world",
    blurb: "A face, body and turnaround per character; four plates per location; "
         + "a sheet per prop. Everything else is anchored on these." },
  { id: "panels", label: "Storyboard panels", later: "Storyboard", needs: ["sheets"],
    blurb: "One drawn frame per shot. The most jobs of the three — a board of "
         + "eight scenes is dozens of renders." },
  { id: "voices", label: "Character voices", later: "Cast & world",
    // The Breeze clause is not a hedge: `cast_breeze_voice` DESIGNS a voice
    // during casting, which happens outside this gate because the measured
    // duration of every line is what floors its shot. So on that engine the
    // clip exists either way and this switch governs the separate recording
    // pass — which is then a no-op. Said here rather than discovered from a
    // cast that has voices after the switch was turned off.
    blurb: "A short timbre clip per speaking character, pinned to their entry "
         + "and heard in every block they are in. Breeze designs its voices "
         + "while casting either way." },
];

/** Why this one cannot be turned on yet, or null. */
export function autoBlocked(step: AutoStep, on: ReadonlySet<AutoKey>): string | null {
  const missing = (step.needs ?? []).filter((k) => !on.has(k));
  if (!missing.length) return null;
  const names = missing.map((k) => AUTO_STEPS.find((s) => s.id === k)!.label.toLowerCase());
  return `needs ${names.join(" and ")} — a panel is composed over them`;
}

/** The set with `key` flipped, and the ladder kept consistent. */
export function toggleAuto(on: ReadonlySet<AutoKey>, key: AutoKey): Set<AutoKey> {
  const next = new Set(on);
  if (next.has(key)) {
    next.delete(key);
    // Turning a prerequisite off takes what depends on it with it, rather
    // than leaving a switch that is on and does nothing — the
    // control-that-cannot-reach-the-render this whole card is about.
    for (const s of AUTO_STEPS) if ((s.needs ?? []).includes(key)) next.delete(s.id);
  } else {
    next.add(key);
    for (const k of AUTO_STEPS.find((s) => s.id === key)?.needs ?? []) next.add(k);
  }
  return next;
}

/**
 * The flags for a `plan_storyboard` job.
 *
 * SPLIT ACROSS TWO OBJECTS, which is a fact about the worker rather than a
 * choice: `plan_refs`, `ref_sheets` and `scene_panels` are read off the
 * PAYLOAD and `voice_refs` off `payload.brief`. Sending the last one at the
 * top level is a flag the deployed pod does not read — voices generate
 * anyway, and nothing says so — so the shape is returned rather than left to
 * each call site to remember. `planAuto.test.ts` parses `worker/llm.py` and
 * fails if either half moves.
 *
 * `plan_refs` is the OUTER gate: with all three off it is false, which skips
 * the whole production block rather than running it to queue nothing.
 */
export function planAutoFlags(on: ReadonlySet<AutoKey>): {
  payload: { plan_refs: boolean; ref_sheets: boolean; scene_panels: boolean };
  brief: { voice_refs: boolean };
} {
  const sheets = on.has("sheets");
  return {
    payload: {
      plan_refs: sheets || on.has("panels") || on.has("voices"),
      ref_sheets: sheets,
      // The ladder again, applied to what is SENT: a payload can only ever
      // ask for a combination the worker would accept.
      scene_panels: sheets && on.has("panels"),
    },
    brief: { voice_refs: on.has("voices") },
  };
}

/**
 * Full auto has nothing to review, so it draws everything.
 *
 * Tier 1 launches the render from the plan job itself — it never passes
 * through the steps whose buttons would draw these — so an episode planned
 * with the switches off would render every block with no sheets, no voices
 * and no panels, and each character invented fresh per block. That is the
 * silent downgrade this file exists to prevent, arriving through a setting
 * two screens away, so tier decides rather than the switches.
 */
export const autoForTier = (tier: 1 | 2, on: ReadonlySet<AutoKey>): Set<AutoKey> =>
  tier === 1 ? new Set(AUTO_STEPS.map((s) => s.id)) : new Set(on);

/** One line for the card's footer: what is still yours to press. */
export function autoSummary(on: ReadonlySet<AutoKey>): string {
  const off = AUTO_STEPS.filter((s) => !on.has(s.id));
  if (!off.length) return "Everything is drawn as soon as the plan lands.";
  if (off.length === AUTO_STEPS.length) {
    return "Nothing is drawn until you ask — read the storyboard first, then "
         + "generate from the Cast & world and Storyboard steps.";
  }
  const names = off.map((s) => s.label.toLowerCase());
  const last = names.pop()!;
  return `${names.length ? `${names.join(", ")} and ${last}` : last} wait for you `
       + `on the ${[...new Set(off.map((s) => s.later))].join(" and ")} step`
       + (new Set(off.map((s) => s.later)).size > 1 ? "s" : "") + ".";
}
