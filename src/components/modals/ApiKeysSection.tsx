// Your own provider keys — the BYOK tab of the local-engine window.
//
// IT LIVES HERE BECAUSE IT IS THE SAME DECISION as the two tabs beside it:
// where does this render happen and what does it cost. The engine tab answers
// "on this machine, free, bounded by the hardware"; this one answers "on
// someone else's GPU, on my card, with no download". Putting keys in project
// settings would have made them a property of a project, which they are not —
// a key is a property of this machine, like the engine and the Ollama beside
// it, and it outlives every project on it.
//
// THE VALUE IS NEVER DISPLAYED, because it is never READABLE — `secrets.rs`
// has no command that hands one back. So a stored key is shown as its last
// four characters and the date it was stored, which is enough to answer "is
// this the key I rotated" and nothing more. The input is write-only by the
// same construction: what you type can be revealed, what is stored cannot.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Plus, Trash2,
  TriangleAlert, X,
} from "lucide-react";
import {
  keyShapeWarning, visibleProviders, type ByokProvider,
} from "../../lib/byokProviders";
import {
  byokOfferings, customId, endpointAlreadyOffered, endpointError,
  type CustomModel,
} from "../../lib/byokCatalog";
import {
  addCustomModel, removeCustomModel, removeKey, setHidden, setKey, verifyKey,
} from "../../lib/byok";
import { useByok } from "../../hooks/useByok";
import { loadCatalog } from "../../lib/catalog";
import { openExternal } from "../../lib/desktop";
import type { ModelCatalogRow } from "../../lib/db/types";

const INK = "#c7cddb";
const MUTE = "#5e6678";
const OK = "#6fd08c";
const WARN = "#e8a13a";
const BAD = "#e8734a";
const ACCENT = "#5aa2ff";

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="mono" style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap",
      color: tone, background: `${tone}1a`, border: `1px solid ${tone}3d`,
    }}>{children}</span>
  );
}

const UNLOCK_LABEL: Record<string, string> = {
  generate: "image & video models",
  chat: "director + one-shot chats",
  planner: "the storyboard planner",
  speak: "voice, on this machine",
};


const when = (secs: number) => {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

/* ── one provider ───────────────────────────────────────────────────────── */

function ProviderCard({ p, onChanged }: {
  p: ByokProvider; onChanged: () => void;
}) {
  const { keys } = useByok();
  const stored = keys.find((k) => k.provider === p.id);
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "verify" | "remove">(null);
  const [msg, setMsg] = useState<{ tone: string; text: string } | null>(null);

  const warn = draft ? keyShapeWarning(p.id, draft) : null;

  const run = async (kind: "save" | "verify" | "remove",
                     fn: () => Promise<string | null>) => {
    setBusy(kind); setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ tone: OK, text });
    } catch (e) {
      setMsg({ tone: BAD, text: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(null); onChanged();
    }
  };

  const save = () => run("save", async () => {
    await setKey(p.id, draft);
    setDraft(""); setShow(false);
    // Verify straight after storing rather than as a separate press: the key
    // was just pasted, so this is the moment a typo is cheapest to find. The
    // store already succeeded, so a failed verify is a warning and not a
    // rollback — a key that stored and could not be checked is still stored.
    const v = await verifyKey(p.id);
    if (!v.ok) { setMsg({ tone: WARN, text: `Saved, but ${p.label} did not accept it — ${v.detail}` }); return null; }
    return `Saved and verified. ${v.detail}`;
  });

  return (
    <div className="ws-card" style={{ padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>{p.label}</span>
        {stored?.present && <Pill tone={OK}><Check size={9} /> key stored</Pill>}
        {stored?.present && stored.tail && (
          <span className="mono" style={{ fontSize: 10.5, color: MUTE }}>
            ····{stored.tail}{stored.set_at ? ` · ${when(stored.set_at)}` : ""}
          </span>
        )}
        {stored?.account && <Pill tone={MUTE}>{stored.account}</Pill>}
        {stored?.orphaned && <Pill tone={WARN}>gone from the keychain</Pill>}
        <div style={{ flex: 1 }} />
        {p.unlocks.map((u) => <Pill key={u} tone={MUTE}>{UNLOCK_LABEL[u]}</Pill>)}
      </div>

      <p style={{ fontSize: 11, color: MUTE, margin: "6px 0 8px", lineHeight: 1.55 }}>
        {p.blurb}{" "}
        <button className="ws-link" style={{ color: ACCENT }}
                onClick={() => void openExternal(p.keysUrl)}>
          get a key <ExternalLink size={9} />
        </button>
      </p>

      {stored?.orphaned && (
        <div style={{ display: "flex", gap: 7, alignItems: "flex-start", marginBottom: 8,
                      fontSize: 11, color: WARN, lineHeight: 1.5 }}>
          <TriangleAlert size={12} style={{ flex: "none", marginTop: 2 }} />
          {/* Reported rather than silently repaired: clearing the record would
              erase the only evidence a key used to be here. */}
          <span>
            This app has a record of a {p.label} key and the keychain does not —
            it was probably removed in Keychain Access. Paste it again to restore it.
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            className="ws-input"
            style={{ width: "100%", fontFamily: "var(--mono, monospace)", fontSize: 11.5,
                     paddingRight: 30 }}
            type={show ? "text" : "password"}
            autoComplete="off" spellCheck={false}
            placeholder={stored?.present ? "Paste a new key to replace the stored one" : `Paste your ${p.label} key`}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setMsg(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && draft.trim() && !busy) void save(); }}
          />
          <button className="ws-link" title={show ? "Hide" : "Show what you typed"}
                  style={{ position: "absolute", right: 6, top: "50%",
                           transform: "translateY(-50%)", color: MUTE }}
                  onClick={() => setShow((v) => !v)}>
            {show ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
        <button className="ws-btn" disabled={!draft.trim() || !!busy} onClick={() => void save()}>
          {busy === "save" ? <><Loader2 size={12} className="ns-spin" /> Saving…</> : "Save"}
        </button>
        {stored?.present && (
          <>
            <button className="ws-btn" disabled={!!busy}
                    title="Ask the provider whether this key still works. Costs nothing."
                    onClick={() => void run("verify", async () => {
                      const v = await verifyKey(p.id);
                      if (!v.ok) throw new Error(v.detail);
                      return v.detail;
                    })}>
              {busy === "verify" ? <><Loader2 size={12} className="ns-spin" /> Checking…</> : "Check"}
            </button>
            <button className="ws-btn" disabled={!!busy} title={`Remove the ${p.label} key`}
                    onClick={() => void run("remove", async () => {
                      await removeKey(p.id); return "Removed.";
                    })}>
              {busy === "remove" ? <Loader2 size={12} className="ns-spin" /> : <Trash2 size={12} />}
            </button>
          </>
        )}
      </div>

      {warn && (
        <div style={{ fontSize: 10.5, color: WARN, marginTop: 6, lineHeight: 1.5 }}>{warn}</div>
      )}
      {msg && (
        <div style={{ fontSize: 10.5, color: msg.tone, marginTop: 6, lineHeight: 1.5 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

/* ── the models a key turns on ──────────────────────────────────────────── */

function AddFalModel({ onAdd, existing }: {
  onAdd: (m: CustomModel) => void;
  /** endpoints already in this user's list, so the form can refuse a second
   *  copy rather than silently replacing the first */
  existing: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"image" | "video">("image");
  const [usd, setUsd] = useState("");
  const covered = endpoint ? endpointAlreadyOffered(endpoint) : null;
  const bad = endpoint
    ? endpointError(endpoint)
      // Both duplicates, and they read differently: one is a model the picker
      // already offers with a MEASURED price beside your guessed one, the
      // other is your own row twice.
      ?? (covered ? "That model is already in your pickers — this build has a "
                  + "priced row for it." : null)
      ?? (existing.has(endpoint.trim()) ? "You have already added that endpoint." : null)
    : null;

  const add = () => {
    const ep = endpoint.trim();
    if (endpointError(ep) || endpointAlreadyOffered(ep) || existing.has(ep)) return;
    const price = Number(usd);
    onAdd({
      id: customId(ep), endpoint: ep,
      label: label.trim() || ep.split("/").slice(1).join(" ") || ep,
      kind,
      modes: kind === "video" ? ["t2v", "i2v"] : ["t2i", "edit"],
      ...(kind === "video" ? { maxSeconds: 10 } : {}),
      // Absent is honest: the composer prints no figure rather than $0.00,
      // which would be a claim about the bill.
      ...(Number.isFinite(price) && price > 0
        ? { usd: price, unit: kind === "video" ? "second" as const : "image" as const }
        : {}),
    });
    setEndpoint(""); setLabel(""); setUsd(""); setOpen(false);
  };

  if (!open) {
    return (
      <button className="ws-btn" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>
        <Plus size={12} /> Add a fal model
      </button>
    );
  }
  return (
    <div className="ws-card" style={{ padding: "10px 12px", display: "flex",
                                      flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>Add a fal model</span>
        <div style={{ flex: 1 }} />
        <button className="ws-link" style={{ color: MUTE }} onClick={() => setOpen(false)}>
          <X size={12} />
        </button>
      </div>
      <p style={{ fontSize: 10.5, color: MUTE, margin: 0, lineHeight: 1.55 }}>
        Paste the endpoint id from the model&rsquo;s page on fal.ai — the part after
        <span className="mono"> fal.run/</span>, e.g. <span className="mono">fal-ai/flux/dev</span>.
        There are thousands and they change weekly, so this list is yours rather than ours.
      </p>
      <input className="ws-input" placeholder="fal-ai/flux/dev" value={endpoint}
             spellCheck={false} autoComplete="off"
             style={{ fontFamily: "var(--mono, monospace)", fontSize: 11.5 }}
             onChange={(e) => setEndpoint(e.target.value)} />
      {bad && <div style={{ fontSize: 10.5, color: WARN, lineHeight: 1.5 }}>{bad}</div>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input className="ws-input" placeholder="Name it (optional)" value={label}
               style={{ flex: "1 1 160px", fontSize: 11.5 }}
               onChange={(e) => setLabel(e.target.value)} />
        <select className="ws-input" value={kind} style={{ fontSize: 11.5 }}
                onChange={(e) => setKind(e.target.value as "image" | "video")}>
          <option value="image">Image</option>
          <option value="video">Video</option>
        </select>
        <input className="ws-input" value={usd} inputMode="decimal"
               style={{ width: 130, fontSize: 11.5 }}
               placeholder={kind === "video" ? "rate / second — optional" : "rate / image — optional"}
               onChange={(e) => setUsd(e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="ws-btn" disabled={!!bad || !endpoint.trim()} onClick={add}>
          <Plus size={12} /> Add
        </button>
      </div>
    </div>
  );
}

function ModelList({ catalog }: { catalog: ModelCatalogRow[] }) {
  const { keyed, config, loaded } = useByok();
  // EXACTLY WHAT THE PICKERS WILL SHOW (`useByokRows` builds from the same two
  // functions), because this list claims to be that. A second rule here is how
  // it comes to list a model nothing offers — the control-that-changes-nothing
  // this codebase keeps naming.
  const offerings = useMemo(
    () => byokOfferings(catalog, keyed, config), [catalog, keyed, config]);

  if (!loaded) return null;
  if (!keyed.size) return null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "2px 2px 8px" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>In your pickers</span>
        <span style={{ fontSize: 11.5, color: MUTE }}>
          untick anything you do not want to see
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 8 }}>
        {offerings.length === 0 && (
          <p style={{ fontSize: 11, color: MUTE, margin: "0 2px", lineHeight: 1.55 }}>
            Nothing yet — this build has no adapter for that provider&rsquo;s models.
            {keyed.has("fal") && " Add a fal endpoint below to start."}
          </p>
        )}
        {offerings.map(({ row, hidden, custom }) => {
          return (
            <label key={row.id} className="ws-card"
                   style={{ padding: "8px 11px", display: "flex", alignItems: "center",
                            gap: 9, cursor: "pointer", opacity: hidden ? 0.5 : 1 }}>
              <input type="checkbox" checked={!hidden}
                     onChange={(e) => setHidden(row.id, !e.target.checked)} />
              <span style={{ fontSize: 12, color: INK }}>{row.display_name}</span>
              <Pill tone={MUTE}>{row.kind}</Pill>
              {custom && <Pill tone={ACCENT}>yours</Pill>}
              <div style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10, color: MUTE }}>
                {(row.capabilities as { endpoint?: string }).endpoint ?? row.provider}
              </span>
              {custom && (
                <button className="ws-link" title="Remove this model" style={{ color: MUTE }}
                        onClick={(e) => { e.preventDefault(); removeCustomModel(row.id); }}>
                  <Trash2 size={11} />
                </button>
              )}
            </label>
          );
        })}
      </div>

      {keyed.has("fal") && (
        <AddFalModel onAdd={addCustomModel}
                     existing={new Set(config.custom.map((c) => c.endpoint))} />
      )}
    </div>
  );
}

/* ── the tab ────────────────────────────────────────────────────────────── */

export default function ApiKeysSection() {
  const { reload, keys, keyed, loaded } = useByok();
  const providers = useMemo(() => visibleProviders(), []);
  const [catalog, setCatalog] = useState<ModelCatalogRow[]>([]);
  useEffect(() => { void loadCatalog().then(setCatalog).catch(() => setCatalog([])); }, []);
  const onChanged = useCallback(() => reload(), [reload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="ws-card" style={{ fontSize: 11.5, color: INK, lineHeight: 1.6 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <KeyRound size={13} style={{ color: ACCENT }} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Your keys, on your machine</span>
        </div>
        Keys go into this computer&rsquo;s keychain — macOS Keychain, Windows Credential
        Manager — and are never handed back to the app. Requests are made in the
        app&rsquo;s native layer and can only ever reach that provider&rsquo;s own hosts.
        {" "}Nothing is copied anywhere else: the pipeline&rsquo;s Python runs on this
        computer too, and reads the key out of the keychain when it starts.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {providers.map((p) => (
          <ProviderCard key={p.id} p={p} onChanged={onChanged} />
        ))}
      </div>

      {loaded && keyed.size > 0 && <ModelList catalog={catalog} />}

      <p style={{ fontSize: 10.5, color: MUTE, margin: "0 2px", lineHeight: 1.55 }}>
        A key here also decides which backends the director and the one-shot interview
        offer: an Anthropic, OpenAI or Google key runs those chats on this machine, as
        does the storyboard planner. With no key at all the director falls back to a
        local model through Ollama — see the Local LLM tab.
      </p>
    </div>
  );
}
