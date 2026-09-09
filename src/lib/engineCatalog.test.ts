/**
 * The download list's ORDER, and the claim that order rests on.
 *
 * A family flagged `studioDefaultFor` is sorted to the head of its media
 * group, and the card says "studio default" because of that flag. Both of
 * those are claims about what `projectSettings.resolveDefaults` actually
 * falls back to — and that function is three files away, so the claim rots
 * silently the day someone changes a default. The symptom would be a download
 * screen leading with, and recommending, a model the studio no longer uses.
 *
 * `projectSettings.ts` cannot be imported here: it builds a Supabase client at
 * module load, which `node --test` has no browser for. So its source is
 * parsed for the two fallback literals — the same shape `scoreTrack.test.ts`
 * uses on `syncMasterTrack`, and for the same reason.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAMILIES, audioFamilies, imageFamilies, studioDefaultIds, videoFamilies,
} from "./engineCatalog.ts";

// Normalised to LF before anything indexes into it: git's default on Windows
// is core.autocrlf=true, and a regex `.` does not match `\r` — which is how a
// source-parsing test comes back reporting "found 0" instead of failing.
const SETTINGS = readFileSync(new URL("./projectSettings.ts", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

/** `image_model: settings?.image_model || app.image_model || "krea2-local",` */
function fallbackFor(field: string): string {
  const re = new RegExp(`${field}:[^\\n]*\\|\\|\\s*"([^"]+)"`);
  const m = SETTINGS.match(re);
  assert.ok(m, `no ${field} fallback literal in projectSettings.ts — did resolveDefaults move?`);
  return m![1];
}

test("the flagged families are the ones resolveDefaults actually falls back to", () => {
  const want = [fallbackFor("image_model"), fallbackFor("video_model")].sort();
  assert.deepEqual(studioDefaultIds().sort(), want);
});

test("exactly one studio default per media group, and it leads the list", () => {
  for (const [media, fams] of [["image", imageFamilies()], ["video", videoFamilies()]] as const) {
    const flagged = fams.filter((f) => f.studioDefaultFor);
    assert.equal(flagged.length, 1, `${media} has ${flagged.length} studio defaults`);
    assert.equal(fams[0].id, flagged[0].id, `${media} does not lead with its studio default`);
  }
});

test("sorting is a stable partition — nothing else is reordered", () => {
  for (const media of ["image", "video"] as const) {
    const declared = FAMILIES.filter((f) => f.media === media && !f.studioDefaultFor)
      .map((f) => f.id);
    const shown = (media === "image" ? imageFamilies() : videoFamilies())
      .filter((f) => !f.studioDefaultFor).map((f) => f.id);
    assert.deepEqual(shown, declared);
  }
});

test("every family is still in exactly one media group", () => {
  // The point of the check: a family in no group is downloadable by nothing.
  // It caught the audio families the day they landed, before the screen did.
  const shown = [...imageFamilies(), ...videoFamilies(), ...audioFamilies()]
    .map((f) => f.id).sort();
  assert.deepEqual(shown, FAMILIES.map((f) => f.id).sort());
});

test("audio has no studio default, and that is not an oversight", () => {
  // `resolveDefaults` has a `music_model`, but it names a POD row
  // (`minimax-music3-local`) and this catalogue's ids are engine families —
  // there is nothing here for it to point at, so claiming one would be a
  // label with no fact behind it. The other two groups are checked above.
  assert.deepEqual(audioFamilies().filter((f) => f.studioDefaultFor), []);
  assert.ok(audioFamilies().length > 0, "audio families exist and are grouped");
});

/* ── the first-run recommendation ───────────────────────────────────────── */

import {
  bestFor, bestVariant, FAMILIES as ALL, blockedFiles, familyBlocker, fitNote, primeMirror,
} from "./engineCatalog.ts";

test("a first run is pointed at the STUDIO DEFAULT when it fits", () => {
  // Plain biggest-that-fits handed a 24GB card the reference EDITOR, because
  // an editor happens to want more memory than the model this studio actually
  // draws its panels with. Adding families is what exposed it; the fix is a
  // preference, not a bigger number.
  const img = bestFor("image", 24);
  assert.equal(img?.family.studioDefaultFor, "krea2-local");
  const vid = bestFor("video", 48);
  assert.equal(vid?.family.studioDefaultFor, "h3-turbo-local");
});

test("…and never at a model whose weights nobody can fetch", () => {
  // Anima's int8 rung fits a 16GB Mac and its text encoder is gated, so the
  // old heuristic recommended a laptop a model it could not download.
  const small = bestFor("image", 9.6);
  assert.ok(small, "something should still fit a 16GB Mac");
  assert.deepEqual(blockedFiles(small!.family, small!.variant, null), [],
    `${small!.family.id} was recommended but cannot be downloaded`);
  for (const media of ["image", "video", "audio"] as const) {
    for (const budget of [4, 8, 12, 16, 24, 48]) {
      const r = bestFor(media, budget);
      if (!r) continue;
      assert.deepEqual(blockedFiles(r.family, r.variant, null), [],
        `${media}@${budget}GB recommends unfetchable ${r.family.id}`);
    }
  }
});

test("the mirror makes a gated family recommendable again", () => {
  // LTX 2.5, because it is the family that is ACTUALLY gated. This used to
  // reach for Anima — whose encoder was a Civitai object behind a token — and
  // Anima stopped being gated the day that url was repointed at CircleStone's
  // own ungated copy. A fixture that names the wrong family fails loudly here,
  // which is the whole point; a test that had quietly kept passing would have
  // been asserting nothing.
  const gatedFam = ALL.find((f) => f.id === "ltx25")!;
  const v = gatedFam.variants[0];
  assert.ok(blockedFiles(gatedFam, v, null).length, "ltx25 is gated upstream");
  // …and hosted by the studio, it is not.
  const all = new Set(
    [...gatedFam.shared, ...v.files].map((f) => f.filename));
  assert.deepEqual(
    blockedFiles(gatedFam, v, { files: all, at: null, base: "https://cdn.example" }), []);
  primeMirror(null);
});

test("a file the studio declines to host must be fetchable without it", () => {
  // `noMirror` and `gated` are opposite claims and CANNOT both hold: gated
  // means upstream refuses us, so the mirror is the only source there is;
  // noMirror means we decline to be a source, which is only survivable while
  // upstream still answers. A file carrying both would be a download with
  // nowhere to come from — offered, and impossible.
  const all = ALL.flatMap((f) => [...f.shared, ...f.variants.flatMap((v) => v.files),
    ...(f.addons ?? []).flatMap((a) => a.files)]);
  const declined = all.filter((f) => f.noMirror);
  assert.ok(declined.length, "the Flux 2 VAE is one; if that changes, say so here");
  for (const f of declined) {
    assert.ok(!f.gated,
      `${f.filename} is both gated upstream and not mirrored — nothing could fetch it`);
    assert.ok(f.noMirror!.length > 20, `${f.filename}: say why`);
  }
});

test("every gated file names a reason, and no reason is attached to an open one", () => {
  // A `gated` marker is what stops a download starting against a URL that
  // answers 401 once the progress bar is on screen — so it has to say WHY,
  // and it must not appear on a file that fetches fine.
  const gated = ALL.flatMap((f) => [...f.shared, ...f.variants.flatMap((v) => v.files)])
    .filter((f) => f.gated);
  assert.ok(gated.length, "some families are gated upstream; that is the point");
  for (const f of gated) assert.ok(f.gated!.length > 20, `${f.filename}: say why`);
});

/* ── the tier benchmark's numbers, and the shapes that keep them honest ──── */

test("at most one PREFERRED rung per family, and it is one the family has", () => {
  // `preferred` overrides biggest-that-fits, so two of them in one family is a
  // silent coin toss decided by declaration order.
  for (const fam of ALL) {
    const pref = fam.variants.filter((v) => v.preferred);
    assert.ok(pref.length <= 1, `${fam.id} nominates ${pref.length} preferred rungs`);
  }
});

test("the preferred rung is not simply the biggest — which is why it exists", () => {
  // If it were, `bestVariant`'s existing heuristic would already land on it and
  // the flag would be decoration. H3 is the case: the pod's own unpruned set
  // has the higher VRAM floor and is beaten by the pruned one at every tier.
  const h3 = ALL.find((f) => f.id === "minimax-h3")!;
  const pref = h3.variants.find((v) => v.preferred)!;
  const biggest = [...h3.variants].sort((a, b) => b.vram_gb - a.vram_gb)[0];
  assert.notEqual(pref.id, biggest.id);
  // …and on a machine that can hold both, the flag is what wins.
  assert.equal(bestVariant(h3, 24, 64)!.id, pref.id);
  assert.equal(bestVariant(h3, 24)!.id, pref.id, "with RAM unknown it still wins");
});

test("a RAM figure only ever appears where it was measured", () => {
  // The catalogue header promises measured numbers, and `ram_gb` is the one
  // most tempting to estimate. Every row that carries one is an H3 rung the
  // 2026-09-01 tier benchmark actually rendered; nothing else claims one.
  const withRam = ALL.flatMap((f) => f.variants.map((v) => ({ fam: f.id, v })))
    .filter((x) => x.v.ram_gb != null);
  assert.ok(withRam.length, "the H3 rungs carry measured RAM");
  for (const { fam } of withRam) assert.equal(fam, "minimax-h3", `${fam} claims an unmeasured RAM figure`);
  for (const { v } of withRam) {
    assert.ok(v.ram_gb! > v.vram_gb,
      `${v.id}: ${v.ram_gb}GB RAM against a ${v.vram_gb}GB card — H3 streams weights through host memory, so RAM is always the larger number`);
  }
});

test("familyBlocker names the budget that actually refused", () => {
  const h3 = ALL.find((f) => f.id === "minimax-h3")!;
  // Plenty of card, not enough memory — the case that sends someone to buy the
  // wrong hardware if the message quotes VRAM.
  assert.match(familyBlocker(h3, 24, 8)!, /system RAM/);
  // Not enough card at all.
  assert.match(familyBlocker(h3, 2, 128)!, /VRAM/);
  // Enough of both.
  assert.equal(familyBlocker(h3, 24, 64), null);
});

test("every H3 rung shares ONE text encoder, except the one that matches the pod", () => {
  // The benchmark's most consequential correction: Abiray's Q4 GGUF encoder
  // OOMs during text encode at 8, 12 AND 16GB — it is a text-encoder defect,
  // not a quantisation one, and pairing every rung with the nvfp4 safetensors
  // encoder turned nine failing cells into renders. A rung that quietly went
  // back to a GGUF encoder would fail in the middle of the range and look like
  // the quantisation being at fault.
  const h3 = ALL.find((f) => f.id === "minimax-h3")!;
  for (const v of h3.variants) {
    const te = v.files.filter((f) => f.dir === "text_encoders");
    assert.equal(te.length, 1, `${v.id} names ${te.length} text encoders`);
    assert.equal(
      te[0].filename,
      v.id === "h3-int8-studio"
        ? "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
        : "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      v.id);
  }
});

test("a scoped add-on names variants that exist — a typo would hide it forever", () => {
  // `forVariants` is what stops four wrong reference checkpoints being offered
  // beside the right one, and it fails SILENTLY: a misspelled id matches no
  // installed variant, so the row simply never appears and the capability
  // looks absent. Nothing else would ever say so.
  for (const fam of ALL) {
    const ids = new Set(fam.variants.map((v) => v.id));
    for (const a of fam.addons ?? []) {
      if (!a.forVariants) continue;
      assert.ok(a.forVariants.length, `${a.id} scopes itself to no variant at all`);
      for (const id of a.forVariants) {
        assert.ok(ids.has(id), `${a.id} is scoped to "${id}", which ${fam.id} does not have`);
      }
    }
  }
});

test("LTX 2.5 declares every file its own workflows load", () => {
  // WHY THIS EXISTS. The catalogue named the transformer, the encoder and the
  // two VAEs and stopped there — so `gen_desktop_model_map.mjs` dropped the
  // whole family with "the engine window cannot download
  // ltx-2.5-latent-spatial-upscaler…, LTX-2.5-Licon-MSR-V1…", and a mirror of
  // "all of LTX 2.5" would have published a set that still cannot render. The
  // omission is invisible from this file: every remaining entry is correct and
  // the family looks complete.
  //
  // The templates are the authority — `ltx25_t2v.json` and `ltx25_r2v.json`
  // are what the pod submits — so they are read rather than restated.
  const fam = FAMILIES.find((f) => f.id === "ltx25")!;
  const named = new Set([
    ...fam.shared.map((f) => f.filename),
    ...fam.variants.flatMap((v) => v.files.map((f) => f.filename)),
  ]);
  for (const wf of ["ltx25_t2v.json", "ltx25_r2v.json"]) {
    const g = JSON.parse(readFileSync(new URL(`../../workflows/${wf}`, import.meta.url), "utf8"));
    for (const node of Object.values(g) as { inputs?: Record<string, unknown> }[]) {
      for (const v of Object.values(node?.inputs ?? {})) {
        if (typeof v !== "string") continue;
        if (!/\.(safetensors|gguf)$/.test(v)) continue;
        assert.ok(named.has(v), `${wf} loads ${v}, which the ltx25 family does not name`);
      }
    }
  }
});

test("LTX 2.5's quantised rungs are GGUF and its pod-matching rung is not", () => {
  // A `.gguf` in a `UNETLoader` is not listed by the node at all, and a
  // safetensors in `UnetLoaderGGUF` is a submit-time refusal — so `precision`
  // decides which loader the local builder picks and getting it wrong is a job
  // that dies after being claimed.
  const fam = FAMILIES.find((f) => f.id === "ltx25")!;
  for (const v of fam.variants) {
    const files = v.files.map((f) => f.filename);
    const gg = files.filter((f) => f.endsWith(".gguf"));
    assert.equal(gg.length > 0, v.precision === "gguf", `${v.id} disagrees with its own files`);
  }
  assert.ok(fam.variants.some((v) => v.precision === "gguf"),
    "the quantised rungs are the only part of LTX 2.5 a first run can fetch unmirrored");
});

test("the MSR LoRA is the one LTX file that needs no mirror", () => {
  // LiconStudio publish it themselves, ungated and Apache-2.0 — so marking it
  // `gated` would withhold a file anyone can fetch, and leave the family
  // unrecommendable for a reason that is not true.
  const fam = FAMILIES.find((f) => f.id === "ltx25")!;
  const msr = fam.shared.find((f) => f.filename === "LTX-2.5-Licon-MSR-V1.safetensors");
  assert.ok(msr, "the MSR IC-LoRA is gone — r2v raises without it");
  assert.equal(msr!.gated, undefined);
  assert.ok(msr!.url.includes("LiconStudio"), "point at the publisher, not a re-upload");
});

test("the first-run wizard asks the MIRROR, not just the machine", () => {
  // IT PASSED `null` AND NEVER FETCHED THE INDEX. `bestFor` refuses a family
  // whose files nothing can fetch, and for a GATED file a null mirror IS
  // "nothing can fetch it" — so every family the studio mirrors was invisible
  // on the one screen that decides what a fresh install downloads, while the
  // engine window two clicks away offered the same models happily.
  //
  // Parsed rather than called: the component builds a React tree and imports
  // the Tauri bridge, so `node --test` cannot construct it. Same shape
  // `scoreTrack.test.ts` uses on `syncMasterTrack`, and for the same reason.
  const src = readFileSync(new URL("../components/modals/FirstRunSetupModal.tsx", import.meta.url),
    "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /await mirrorIndex\(\)/,
    "the wizard must load the mirror before it recommends anything");
  for (const media of ["image", "video"]) {
    assert.match(src, new RegExp(`bestFor\\("${media}", budget, mirror, ram\\)`),
      `bestFor("${media}") is not being handed the mirror`);
  }
  assert.doesNotMatch(src, /bestFor\([^)]*,\s*null\s*,/,
    "a null mirror here silently withholds every gated family");
});

test("a gated family becomes recommendable EXACTLY when the mirror has it", () => {
  // The claim the fix above rests on, checked against the real catalogue rather
  // than asserted: LTX 2.5's weights are gated, so with no mirror it can never
  // be the answer however big the machine is — and with one it can.
  const ltx = FAMILIES.find((f) => f.id === "ltx25")!;
  const huge = 96, ram = 256;
  assert.equal(bestFor("video", huge, null, ram)?.family.id === "ltx25", false,
    "with no mirror a gated family must never be recommended");
  const mirror = {
    files: new Set(ltx.shared.concat(ltx.variants.flatMap((v) => v.files))
      .map((f) => f.filename)),
    at: null, base: "https://cdn.example",
  };
  assert.equal(blockedFiles(ltx, ltx.variants[0]!, mirror).length, 0,
    "every gated LTX file must resolve once the mirror holds it");
});

test("an ESTIMATED vram figure never renders as a verdict", () => {
  // The two numbers look identical on screen and mean opposite things: H3's
  // are floors a render cleared under an enforced cap, LTX's are arithmetic
  // over file sizes. The H3 benchmark disproved file size as a predictor — its
  // GGUF rungs are 12-18GB files that rendered inside 6GB — so an estimate
  // said flatly refuses a machine on nobody's evidence.
  const ltx = ALL.find((f) => f.id === "ltx25")!;
  assert.ok(ltx.variants.every((v) => v.vramEstimated),
    "nothing has benchmarked LTX, so every rung must say so");
  for (const v of ltx.variants) {
    const note = fitNote(v, 8, Infinity)!;
    assert.match(note, /estimated/, `${v.id} states a floor it does not have`);
    assert.doesNotMatch(note, /out of reach/, `${v.id} refuses on a guess`);
  }
  assert.match(familyBlocker(ltx, 8, Infinity)!, /estimated/);

  // …and a MEASURED family is untouched: H3's rungs keep the flat verdict,
  // which they have earned.
  const h3 = ALL.find((f) => f.id === "minimax-h3")!;
  assert.ok(h3.variants.every((v) => !v.vramEstimated));
  assert.match(fitNote(h3.variants[0]!, 2, Infinity)!, /out of reach/);
});

test("a swappable ladder names real variants, and only real ladders", () => {
  // `swappable` is what `gen_desktop_model_map.mjs` turns into the rung table
  // `resolve.load_map()` applies, so anything in it may be SUBSTITUTED for
  // anything else in it, silently, in a render somebody paid for. Two ways
  // that goes wrong and both are pinned here.
  for (const f of ALL) {
    const ids = new Set(f.variants.map((v) => v.id));
    for (const id of f.swappable ?? []) {
      assert.ok(ids.has(id), `${f.id}'s ladder names ${id}, which is not a variant`);
    }
    if (f.swappable) {
      assert.ok(f.swappable.length > 1,
        `${f.id}'s ladder has nothing to swap with`);
    }
  }

  // THE THREE FAMILIES WHOSE VARIANTS ARE DIFFERENT CHECKPOINTS, named rather
  // than merely absent — an omission nobody wrote down is one somebody later
  // "fixes". Each would be a silent downgrade of a different kind: sdxl and
  // stable-audio swap a distilled model for one wanting six times the steps,
  // and `h3-dasiwa` is a community merge with NO verified r2v — the one mode
  // every episode block renders in.
  for (const [fam, why] of [
    ["sdxl", "Turbo is 4 steps and Base wants 30"],
    ["stable-audio", "three checkpoints, one of them 50 steps at cfg 7"],
  ] as const) {
    const f = ALL.find((x) => x.id === fam)!;
    assert.ok(f.variants.length > 1 && !f.swappable,
      `${fam} must stay off the ladder — ${why}`);
  }
  const h3 = ALL.find((f) => f.id === "minimax-h3")!;
  assert.ok(h3.swappable && !h3.swappable.includes("h3-dasiwa"),
    "h3-dasiwa is a merge with no verified r2v — it may never be substituted in");
  assert.ok(h3.swappable!.includes("h3-int8") && h3.swappable!.includes("h3-q4"),
    "H3's real precision rungs still ladder");
});
