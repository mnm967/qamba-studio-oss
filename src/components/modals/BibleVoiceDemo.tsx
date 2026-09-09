// The bible sheet's voice row, in every casting state at once. /ui/biblevoice.
//
// WHY IT IS HERE. The real one is behind a sign-in, a project, a bible entry
// and a plan that has already cast somebody — and what it has to get right is
// a PICTURE: four engines in one menu, each row marked from the entry's own
// casting, and the ones that keep a DESIGNED CLIP (`doc.<engine>_voice`)
// distinguished from the one that keeps a stock id. That claim was wrong twice
// before this screen existed: `providerForEntry` walked Breeze alone, so a
// character cast on the second local engine read as UNCAST and the sheet
// opened on Breeze offering to re-record a voice that already existed; and the
// three menu rows were forty lines of hand-written JSX apiece, which is three
// places for one layout to drift.
//
// IT CANNOT QUEUE. `onSaveDoc` is stubbed, so choosing an engine writes into
// this screen's own state rather than the database — and there is no session
// here, so the Record button's `enqueueJob` is refused by RLS before it
// reaches a lane. Nothing on this page spends anything.
import React, { useState } from "react";
import BibleVoiceClip from "./BibleVoiceClip";
import type { BibleEntry } from "../../lib/db/types";

const entry = (name: string, doc: Record<string, unknown>): BibleEntry => ({
  id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, "0")}`,
  project_id: "00000000-0000-4000-8000-000000000000",
  kind: "character",
  name,
  identity_line: "Fifties, weathered, grey braid, oil-stained coat.",
  summary: null,
  doc: { voice: "Low, gravelled contralto. Unhurried, with a dry edge.", ...doc },
  voice_ref_asset_id: doc.voice_provider ? "asset-0000" : null,
} as unknown as BibleEntry);

/** The states worth looking at side by side — each is a different reading of
 *  the SAME row, and three of them were indistinguishable before this. */
const CASES: { title: string; why: string; entry: BibleEntry }[] = [
  {
    title: "never cast",
    why: "no provider and no clip — the sheet opens on the default and offers "
      + "to record",
    entry: entry("Marla Vance", {}),
  },
  {
    title: "cast on Breeze",
    why: "`voice_provider` names it and `breeze_voice` holds the designed clip",
    entry: entry("Dennis Okonkwo", {
      voice_provider: "breeze",
      breeze_voice: { asset_id: "a1", ref_text: "a plain sentence" },
    }),
  },
  {
    title: "cast on Qwen",
    why: "THE ONE THAT USED TO READ AS UNCAST: a second local engine keeps its "
      + "clip at its own key, and an inference that walked Breeze alone found "
      + "nothing here",
    entry: entry("Priya Raman", {
      voice_provider: "qwen",
      qwen_voice: { asset_id: "a2", ref_text: "a plain sentence" },
    }),
  },
  {
    title: "a clip but no stored provider",
    why: "the inference half — `providerForEntry` reads the casting off the "
      + "clip the plan left behind, and must walk EVERY local engine",
    entry: entry("Fenella Okoro", {
      qwen_voice: { asset_id: "a3", ref_text: "a plain sentence" },
    }),
  },
  {
    title: "cast on ElevenLabs",
    why: "a stock id rather than a clip — the other shape entirely, and the "
      + "row that must not be confused with a designed one",
    entry: entry("Tam Reed", { voice_provider: "elevenlabs", el_voice_id: "EXAVITQu4vr4xnSDxMaL" }),
  },
];

function Case({ title, why, entry: e }: { title: string; why: string; entry: BibleEntry }) {
  // The sheet's own doc, held here so choosing an engine is visible without a
  // database — `onSaveDoc` is what the component writes through.
  const [doc, setDoc] = useState<Record<string, unknown>>(
    (e.doc ?? {}) as Record<string, unknown>);
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: ".08em",
                                        textTransform: "uppercase", color: "#5aa2ff" }}>
          {title}
        </span>
        <span style={{ fontSize: 11.5, color: "#7a8398", flex: 1, minWidth: 220 }}>
          {why}
        </span>
        <span className="mono" style={{ fontSize: 10, color: "#4d5566" }}>
          voice_provider={String(doc.voice_provider ?? "—")}
        </span>
      </div>
      <div className="ws-bs" style={{ border: "1px solid #1e2432", borderRadius: 10 }}>
        <BibleVoiceClip
          entry={{ ...e, doc } as BibleEntry}
          asset={null}
          onSaveDoc={async (k, v) => { setDoc((d) => ({ ...d, [k]: v })); }}
          onChanged={() => {}}
        />
      </div>
    </section>
  );
}

export default function BibleVoiceDemo() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26, padding: 20,
                  maxWidth: 760 }}>
      {/* `.ws-card` is the harness's MOUNT SIGNAL as well as a header —
          `open()` in scripts/ui-test.mjs waits for one of four shells before
          it asserts anything, and a screen that renders none of them times out
          looking like a broken route. */}
      <div className="ws-card">
        <p style={{ fontSize: 12, color: "#7a8398", margin: 0, lineHeight: 1.6 }}>
          The bible sheet's voice row. Open a picker: every local engine has a
          row of its own, and each case below opens on the engine its own entry
          was cast on. Nothing here queues — the doc is this page's state and
          there is no session.
        </p>
      </div>
      {CASES.map((c) => <Case key={c.title} {...c} />)}
    </div>
  );
}
