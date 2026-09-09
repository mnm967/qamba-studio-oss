// What a queue row can SHOW, and what it can CHANGE.
//
// "The prompt" means two different things in this queue, and conflating them
// is how a panel ends up presenting a fiction:
//
//   * `clip_gen`, `image_gen`, `music_gen`, `sfx_gen`, `tts`, `video_edit`,
//     `transition_gen` send `payload.prompt` (or `text`) to ComfyUI VERBATIM —
//     invariant #6's documented exception. The queued row IS the prompt, and
//     editing it changes exactly what renders.
//   * `master_pass` carries NO prompt at all. `handle_master_pass` compiles the
//     H3/LTX envelope from the block's beats when the worker CLAIMS the job, so
//     at `queued` there is no prompt yet — only the block's LAST compiled one
//     and the per-job overrides the payload does carry. The editor for those is
//     the block's own retake modal, which already labels the prompt it shows as
//     the previous render's rather than the next one's.
//
// Getting that split wrong is silent in the worst way: an editable box over a
// `master_pass` row would take a rewrite, requeue happily, and render the
// unchanged beats — the shape of failure this codebase keeps naming.
//
// Two rows sit between the extremes and are the most useful things here:
//   * `patch_flf` takes `payload.prompt` as an OVERRIDE and falls back to the
//     block's compiled prompt when it is empty.
//   * `llm_task{task:"revise_block"}` — queued by the prompt & references modal
//     with the `master_pass` DEPENDING ON IT — carries the brief that rewrites
//     the beats. On a block re-render that is the text that decides the prompt,
//     one row upstream.
//
// Pure, and importing nothing: db/jobs.ts reaches supabase at import time, so
// this lives on its own for the same reason retryPlan.ts does.

export type FieldKind = "prose" | "line";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  /** Shown even when the payload holds no such key. Everything else appears
   *  only where the enqueuer already wrote one — see `describeJob`. */
  primary?: boolean;
}

export interface PromptField extends FieldSpec { value: string }

export interface JobFact { label: string; value: string }

/** Where this row's prompt lives. */
export type PromptShape =
  /** in `payload` — editable, and what the worker sends. */
  | "payload"
  /** compiled from the beats at claim time — nothing to edit here. */
  | "compiled"
  /** the row is not a generation at all. */
  | "none";

export interface JobPromptView {
  shape: PromptShape;
  fields: PromptField[];
  facts: JobFact[];
  /** The block this row renders, when it has one — the route into the retake
   *  modal, which is the real editor for anything `compiled`. */
  blockId: string | null;
  /** Why there is nothing to edit, when there isn't. */
  note: string | null;
}

export interface JobLike {
  kind: string;
  status: string;
  payload?: Record<string, unknown> | null;
  depends_on?: string[] | null;
}

const PROMPT: FieldSpec = { key: "prompt", label: "Prompt", kind: "prose", primary: true };
const NEGATIVE: FieldSpec = {
  key: "negative", label: "Negative prompt", kind: "prose",
  hint: "Only present where the model samples a negative branch — the composer omits it elsewhere, "
      + "and an empty box means model_map's own default rather than no negative.",
};

/** The prompt-carrying kinds, and what each one calls its text. */
const FIELDS: Record<string, FieldSpec[]> = {
  clip_gen: [PROMPT, NEGATIVE],
  image_gen: [PROMPT, NEGATIVE],
  sfx_gen: [PROMPT, NEGATIVE],
  image_upscale: [PROMPT],
  transition_gen: [PROMPT],
  music_gen: [
    { ...PROMPT, label: "Style prompt" },
    { key: "lyrics", label: "Lyrics", kind: "prose", hint: "Absent on an instrumental." },
  ],
  tts: [
    { key: "text", label: "Line", kind: "prose", primary: true },
    // ONE FIELD, TWO MEANINGS, and the caption named only the first — over a
    // `provider: breeze` job, in the modal, which is where somebody goes to
    // find out what was sent. ElevenLabs takes a closed set of tags, so the
    // prose is keyword-matched onto one; Breeze and Qwen take open language,
    // so it is handed over as written — and for a character with no cast
    // voice it is what the voice itself is DESIGNED from, which is why its
    // tail is not decoration.
    // ...and it is NOT the whole instruction on the design path, which is the
    // one people read this modal to check. Breeze builds that at render time
    // from this prose PLUS the speaker's apparent age and sex, which live in
    // the identity line and are therefore in no payload — so the field alone
    // reads as "the engine got no details" when the engine got them. The
    // finished clip records what was really sent (`assets.meta.instruction`).
    { key: "emotion", label: "Delivery", kind: "line",
      hint: "ElevenLabs maps it onto one leading v3 audio tag. Breeze and Qwen take "
          + "it as open prose — and for a character with no cast voice they design "
          + "one from it plus the apparent age and sex on their bible entry, so the "
          + "sentence the engine gets is longer than this. The clip records it." },
  ],
  video_edit: [{
    key: "prompt", label: "Edit instruction", kind: "prose", primary: true,
    hint: "What changes. Framing, timing and subjects you do not name are held.",
  }],
  patch_flf: [{
    key: "prompt", label: "Prompt override", kind: "prose", primary: true,
    hint: "Left empty this segment re-renders on the block's own compiled prompt.",
  }],
};

/** `llm_task` is one kind over half a dozen jobs; `payload.task` is the real
 *  discriminator, exactly as `handle_llm_task` reads it. */
const LLM_FIELDS: Record<string, FieldSpec[]> = {
  revise_block: [{
    key: "brief", label: "Brief", kind: "prose", primary: true,
    hint: "Rewrites the shot's beats. The render then compiles from them, which is why "
        + "this is what changes a block re-render rather than any prompt text.",
  }],
  enhance_prompt: [{ key: "prompt", label: "Prompt to rewrite", kind: "prose", primary: true }],
  vlm_query: [{ key: "question", label: "Question", kind: "prose", primary: true }],
};

/** Kinds whose prompt does not exist until the worker claims the job. */
const COMPILED = new Set(["master_pass"]);

/** Mirrors `_BLOCK_FLAGS` in worker/handlers/blocks.py — the per-job overrides
 *  `handle_master_pass` lifts off the payload onto the block's params. Listed
 *  because on a block re-render they are the ONLY thing about the render that
 *  is knowable before the compile, so they are what the panel can honestly
 *  report. Read-only here: a bad `model_key` or an off-grid `steps` fails deep
 *  in the sampler, and this panel is not the place to invite that. */
export const BLOCK_OVERRIDES = [
  "model_key", "loras", "steps", "refine", "split_pass", "fight", "motion_ctx",
  // The camera-motion adapter, stamped at plan time like `fight` (a block
  // whose shots move the camera), and the latent-upscale second pass — the
  // small-first-pass-then-learned-resize render that is the one second pass
  // a PDD block can run.
  "camera_motion", "latent_upscale",
  "el_dialogue", "force_line_clips", "prompt_extra",
  // Which path a locked-DIALOGUE block's audio takes: "ref" (the default —
  // the recorded lines stage as Ref2VA references and H3 generates the
  // track, lips and room included) or "locked" (pin the audiolock back: the
  // spine slice ships 1:1, exact words, silent room). Music-video blocks
  // ignore it — reproducing the master track is that product's contract.
  "dialogue_audio",
  // What <Audio 1> IS on a locked block — a music-video master track, or this
  // storyboard's own recorded dialogue (the spine). Stamped at plan time, and
  // worth surfacing: it decides whether the compiled envelope says the cast
  // SINGS or SAYS its lines.
  "locked_kind",
  // The block's SEGMENT STORYBOARD: one numbered contact sheet carrying every
  // shot, staged whole as a single `<Picture N>` IN PLACE OF the per-beat
  // panels. Worth surfacing next to the prompt for the same reason
  // `locked_kind` is — its presence changes what the envelope says about every
  // shot ("cuts to panel 3 of <Picture 1>" rather than a bare cut), and it is
  // the difference between a four-shot block composing two of its shots and
  // all four.
  "sheet_asset_id",
  // Whether the environment's ONE picture slot carries its COVERAGE contact
  // sheet — every camera placement in one grid, the location's answer to a
  // character's turnaround — or its plain master plate. Surfaced beside the
  // prompt for `locked_kind`'s reason: it changes what the envelope says
  // about the place in every shot, and it is the flag an A/B of the two arms
  // is run on.
  "env_coverage",
] as const;

/** Payload keys worth printing beside the prompt, in this order. Deliberately
 *  read-only: they are the shape of the render (a grid-legal frame count, a
 *  resolvable model key), and every way of getting one wrong fails minutes
 *  later inside ComfyUI rather than here. */
const FACT_KEYS: { key: string; label: string }[] = [
  { key: "mode", label: "Mode" },
  { key: "model_key", label: "Model key" },
  { key: "workflow_id", label: "Custom workflow" },
  { key: "seed", label: "Seed" },
  { key: "steps", label: "Steps" },
  { key: "loras", label: "LoRAs" },
  { key: "bpm", label: "BPM" },
  { key: "key_scale", label: "Key" },
  { key: "time_signature", label: "Time signature" },
  { key: "instrumental", label: "Instrumental" },
  { key: "voice", label: "Voice" },
  { key: "provider", label: "Provider" },
  { key: "task", label: "Task" },
];

const isText = (v: unknown): v is string => typeof v === "string";
const filled = (v: unknown): boolean => isText(v) && v.trim() !== "";

/** One payload value as a line of text. A LoRA stack is the case that matters:
 *  `[{key,strength}]` printed as JSON is unreadable exactly where "did this
 *  requeue keep my adapters?" is the question being asked. */
export function factValue(v: unknown): string {
  if (v == null) return "";
  if (isText(v)) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const picks = v
      .filter((x): x is { key: string; strength?: number } =>
        !!x && typeof x === "object" && isText((x as { key?: unknown }).key))
      .map((x) => `${x.key}@${x.strength ?? 1}`);
    if (picks.length === v.length && picks.length) return picks.join(", ");
    return `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  return JSON.stringify(v);
}

function facts(job: JobLike, payload: Record<string, unknown>): JobFact[] {
  const out: JobFact[] = [];
  // FACT_KEYS and BLOCK_OVERRIDES genuinely overlap — `model_key`, `steps` and
  // `loras` are both "sent with it" and block-shaping flags — so without this
  // a block re-render lists each of them twice, under two different spellings,
  // which reads as two settings that happen to agree.
  const seen = new Set<string>();
  const push = (label: string, value: string, key = label) => {
    if (!value || seen.has(key)) return;
    seen.add(key);
    out.push({ label, value });
  };

  const w = payload.width;
  const h = payload.height;
  if (typeof w === "number" && typeof h === "number") push("Size", `${w} x ${h}`);
  const ms = payload.duration_ms;
  if (typeof ms === "number") push("Length", `${(ms / 1000).toFixed(2)}s`);

  for (const f of FACT_KEYS) {
    if (f.key in payload) push(f.label, factValue(payload[f.key]), f.key);
  }

  const refs = payload.ref_asset_ids;
  if (Array.isArray(refs) && refs.length) push("References", `${refs.length} staged`);
  if (filled(payload.start_asset_id)) push("Start frame", "staged");
  if (filled(payload.end_asset_id)) push("End frame", "staged");

  // A block re-render's overrides, which are all it can say about itself.
  if (COMPILED.has(job.kind)) {
    const params = (payload.params && typeof payload.params === "object"
      ? payload.params : {}) as Record<string, unknown>;
    for (const k of BLOCK_OVERRIDES) {
      // The payload's own value wins, exactly as `_block_params` merges them:
      // `{**block.params, **_block_params(payload)}`.
      if (k in payload) push(k, factValue(payload[k]), k);
      else if (k in params) push(k, factValue(params[k]), k);
    }
  }
  return out;
}

/** What this row holds, and what of it can be changed. */
export function describeJob(job: JobLike): JobPromptView {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const blockId = isText(payload.block_id) ? payload.block_id : null;
  const task = isText(payload.task) ? payload.task : null;
  const specs = job.kind === "llm_task"
    ? (task ? LLM_FIELDS[task] : undefined)
    : FIELDS[job.kind];
  const base = { facts: facts(job, payload), blockId };

  if (specs) {
    const fields = specs
      .filter((s) => s.primary || filled(payload[s.key]))
      .map((s) => ({ ...s, value: isText(payload[s.key]) ? (payload[s.key] as string) : "" }));
    return { ...base, shape: "payload", fields, note: null };
  }
  if (COMPILED.has(job.kind)) {
    return {
      ...base, shape: "compiled", fields: [],
      note: "This render has no prompt yet. The envelope is compiled from the block's beats "
          + "when the worker claims the job, so the only text that exists right now is the "
          + "block's last render. Open the block to change what the next one will say.",
    };
  }
  return {
    ...base, shape: "none", fields: [],
    note: "Nothing in this row is a prompt — it is bookkeeping the worker does for itself.",
  };
}

/** Why this row cannot be edited, or null when it can.
 *
 *  `queued` is the whole window: `claim_next_job` reads the payload once when
 *  it takes the row, so a change that lands after the claim is a no-op wearing
 *  a success message. */
export function editBlocker(job: JobLike): string | null {
  if (job.status !== "queued") {
    return job.status === "running"
      ? "This one has already started. Cancel it if you want to render it differently."
      : `Only a queued job can be changed — this one is ${job.status}.`;
  }
  const view = describeJob(job);
  if (view.shape !== "payload") return view.note;
  if (!view.fields.length) return "This row carries no editable text.";
  return null;
}

/** The fields whose text the user actually changed — trimmed-compared, so
 *  trailing whitespace alone never queues a render. */
export function changedFields(
  view: JobPromptView, draft: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of view.fields) {
    const next = draft[f.key];
    if (next === undefined) continue;
    if (next.trim() === f.value.trim()) continue;
    out[f.key] = next;
  }
  return out;
}
