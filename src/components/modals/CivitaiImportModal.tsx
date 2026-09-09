// The Civitai hub: search, import, and — the part that matters — the REPORT on
// what was imported.
//
// WHY THE REPORT IS THE FEATURE. Importing a graph is a two-line operation;
// the reason this screen exists is that a downloaded ComfyUI workflow is
// almost never runnable here as-is. It was authored against someone else's
// node packs, someone else's filenames, and often their local Ollama. Every
// one of those failures is silent at import time and expensive at render time
// — a job that dies on the pod minutes later, naming a node the user never
// saw. So conversion warnings, the tagged slots, the missing classes and the
// missing files are all shown BEFORE anything is stored, and the row is saved
// as 'draft' regardless: only a render makes a workflow 'ready'.
//
// SEARCH AND IMPORT HAVE DIFFERENT REQUIREMENTS, and the screen says so up
// front rather than at the point of failure. Search is anonymous and works
// everywhere. Downloads need an API token in every case — Civitai answers a
// tokenless download with 200 and its own HTML page (measured: three
// "Public"-availability workflows all returned 9,685 bytes of text/html), so a
// client that trusts the status code stores a web page as a workflow. The
// paste/drop tab is therefore not a fallback, it is the path that always
// works.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Check, Clipboard, Cloud, Download, ExternalLink, FileJson, Film,
  Globe, Key, Loader2, Search, Upload, Workflow as WorkflowIcon,
} from "lucide-react";
import ModalShell from "./ModalShell";
import CivitaiDetailModal, { Chip, num } from "./CivitaiDetailModal";
import CompatPanel from "./CompatPanel";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import {
  canDownload, explicit, fetchWorkflowGraphs, firstPreview, getToken, isVideo,
  mediaUrl, searchCivitai, setToken, workflowFile,
  type CivitaiModel, type CivitaiType, type CivitaiVersion, type WorkflowCandidate,
} from "../../lib/civitai";
import { isDesktop, openExternal } from "../../lib/desktop";
import { DEFAULT_COMFY, filesFromObjectInfo, getObjectInfo, pingComfy } from "../../lib/comfyLocal";
import { importWorkflow, type CustomWorkflow } from "../../lib/db/customWorkflows";
import {
  detectSlots, toApiGraph, validateGraph,
  type ObjectInfo, type SlotMap, type ValidationIssue,
} from "../../lib/workflowAdapter";
import { analyseGraph, compatEnv, type CompatReport } from "../../lib/compat";

const INK_MUTE = "#5e6678";
const C_OK = "#6fd08c";
const C_RISK = "#e8a13a";
const C_BROKEN = "#e8734a";

type Tab = "workflows" | "loras" | "models" | "paste";

const TABS: { id: Tab; label: string; types?: CivitaiType[]; icon: React.ReactNode }[] = [
  // Civitai files workflows under `Workflows`, NOT `Other` — searching Other
  // returns none of them.
  { id: "workflows", label: "Workflows", types: ["Workflows"], icon: <WorkflowIcon size={12} /> },
  { id: "loras", label: "LoRAs", types: ["LORA"], icon: <Cloud size={12} /> },
  { id: "models", label: "Checkpoints & upscalers", types: ["Checkpoint", "Upscaler"], icon: <Download size={12} /> },
  { id: "paste", label: "Paste or drop JSON", icon: <Clipboard size={12} /> },
];

/* ── a result card ──────────────────────────────────────────────────────── */

/**
 * The preview on these model types is usually a VIDEO — every showcase item on
 * the top MiniMax H3 workflows is an .mp4 — so a card that renders only stills
 * shows a grey placeholder for most of a search, which is what this grid did.
 *
 * It is still an <img>: `mediaUrl(…, "card")` asks the CDN for a video's
 * poster frame. Playing them here would mean up to 24 previews of a median
 * several MB each (one measured 161MB), for a decision that is made in the
 * detail screen anyway.
 */
function ResultCard({ m, onOpen }: { m: CivitaiModel; onOpen: () => void }) {
  const media = firstPreview(m);
  const blur = media ? explicit(media.nsfwLevel, m.nsfw) : false;

  return (
    <button onClick={onOpen} className="ws-card"
            style={{ textAlign: "left", padding: 0, overflow: "hidden" }}>
      <div style={{
        height: 108, background: "#0d1017", overflow: "hidden", position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {/* A model card's preview is user-uploaded media from a public site: it
            is shown, never trusted, and nothing on this card is clickable
            except the card itself. */}
        {media ? (
          <>
            <img src={mediaUrl(media, "card")} alt="" loading="lazy" referrerPolicy="no-referrer"
                 style={{ width: "100%", height: "100%", objectFit: "cover",
                          filter: blur ? "blur(14px)" : undefined }} />
            {isVideo(media) && (
              <span style={{
                position: "absolute", right: 5, bottom: 5, padding: "1px 4px", borderRadius: 5,
                background: "rgba(6,9,14,0.72)", display: "inline-flex", gap: 3,
                alignItems: "center", fontSize: 9, color: "#c7cddb",
              }}><Film size={8} /> video</span>
            )}
          </>
        ) : <WorkflowIcon size={20} style={{ color: INK_MUTE }} />}
      </div>
      <div style={{ padding: "7px 9px 9px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3,
                      display: "-webkit-box", WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {m.name}
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
          <Chip>↓ {num(m.stats?.downloadCount)}</Chip>
          <Chip>♥ {num(m.stats?.thumbsUpCount)}</Chip>
          {m.nsfw && <Chip color={C_RISK}>nsfw</Chip>}
        </div>
        <div style={{ fontSize: 10.5, color: INK_MUTE, marginTop: 4 }}>
          {m.creator?.username ?? "unknown"}
        </div>
      </div>
    </button>
  );
}

/* ── the import report ──────────────────────────────────────────────────── */

interface Report {
  name: string;
  slots: SlotMap;
  issues: ValidationIssue[];
  warnings: { level: string; message: string; node?: string; class_type?: string }[];
  unmapped: string[];
  nodeCount: number;
  /** null until it is stored */
  saved: CustomWorkflow | null;
  /** was an engine reachable to check against */
  checkedAgainst: string | null;
  /** what the graph needs against what this machine has */
  compat: CompatReport;
}

function SlotLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0" }}>
      <span style={{ color: INK_MUTE, width: 104, flex: "none" }}>{label}</span>
      <span className="mono" style={{ fontSize: 11.5 }}>{value}</span>
    </div>
  );
}

function ReportPanel({ r, onClose }: { r: Report; onClose: () => void }) {
  const errors = r.issues.filter((i) => i.level === "error");
  const warns = [...r.issues.filter((i) => i.level === "warn"),
                 ...r.warnings.filter((w) => w.level === "error" || w.level === "warn")];
  const slot = (s?: { node: string; input: string; class_type: string }) =>
    s ? `${s.class_type} #${s.node}.${s.input}` : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="ws-card" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Check size={14} style={{ color: C_OK, flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</div>
          <div style={{ fontSize: 11.5, color: INK_MUTE }}>
            {r.saved ? "Saved as a draft" : "Not saved"} · {r.nodeCount} nodes
            {r.checkedAgainst
              ? ` · checked against ${r.checkedAgainst}`
              : " · no engine was reachable, so nothing checked the node list"}
          </div>
        </div>
        <button className="ws-actbtn" onClick={onClose}>Done</button>
      </div>

      <CompatPanel r={r.compat} />

      <div className="ws-card">
        <span className="ws-mlabel">TAGGED SLOTS</span>
        <p style={{ fontSize: 11.5, color: INK_MUTE, margin: "0 0 4px" }}>
          What the studio will write into when it renders this graph. Anything unset
          keeps whatever the author put there.
        </p>
        <SlotLine label="Prompt" value={slot(r.slots.prompt)
          ?? <span style={{ color: C_RISK }}>not found — the graph renders its own prompt</span>} />
        {r.slots.negative && <SlotLine label="Negative" value={slot(r.slots.negative)} />}
        <SlotLine label="Seed" value={slot(r.slots.seed) ?? <span style={{ color: C_RISK }}>not found</span>} />
        <SlotLine label="Size" value={r.slots.size
          ? `${r.slots.size.class_type} #${r.slots.size.node}`
            + ` (${[r.slots.size.width, r.slots.size.height, r.slots.size.length].filter(Boolean).join(", ")})`
          : <span style={{ color: C_RISK }}>not found — the graph's own size renders</span>} />
        {r.slots.start_frame && <SlotLine label="Start frame" value={slot(r.slots.start_frame)} />}
        {r.slots.end_frame && <SlotLine label="End frame" value={slot(r.slots.end_frame)} />}
        {r.slots.refs && <SlotLine label="References" value={`${r.slots.refs.class_type} #${r.slots.refs.node}`} />}
        <SlotLine label="Output" value={r.slots.output?.length
          ? r.slots.output.map((o) => `${o.class_type} #${o.node}`).join(", ")
          : <span style={{ color: C_BROKEN }}>none — nothing would be saved</span>} />
      </div>

      {errors.length > 0 && (
        <div className="ws-card" style={{ border: "1px solid rgba(232,115,74,0.28)" }}>
          <span className="ws-mlabel" style={{ color: C_BROKEN }}>
            {errors.length} BLOCKING {errors.length === 1 ? "ISSUE" : "ISSUES"}
          </span>
          {errors.slice(0, 12).map((i, n) => (
            <div key={n} style={{ display: "flex", gap: 7, padding: "3px 0", fontSize: 12 }}>
              <AlertTriangle size={12} style={{ color: C_BROKEN, flex: "none", marginTop: 2 }} />
              <span>{i.message}{i.hint && <span style={{ color: INK_MUTE }}> — {i.hint}</span>}</span>
            </div>
          ))}
          {errors.length > 12 && (
            <span style={{ fontSize: 11.5, color: INK_MUTE }}>…and {errors.length - 12} more</span>
          )}
        </div>
      )}

      {warns.length > 0 && (
        <div className="ws-card">
          <span className="ws-mlabel" style={{ color: C_RISK }}>{warns.length} WARNING{warns.length === 1 ? "" : "S"}</span>
          {warns.slice(0, 10).map((w, n) => (
            <div key={n} style={{ display: "flex", gap: 7, padding: "3px 0", fontSize: 12, color: "#c7cddb" }}>
              <AlertTriangle size={12} style={{ color: C_RISK, flex: "none", marginTop: 2 }} />
              <span>{w.message}</span>
            </div>
          ))}
          {warns.length > 10 && (
            <span style={{ fontSize: 11.5, color: INK_MUTE }}>…and {warns.length - 10} more</span>
          )}
        </div>
      )}

      {r.unmapped.length > 0 && (
        <div className="ws-card">
          <span className="ws-mlabel">{r.unmapped.length} UNMAPPED NODE {r.unmapped.length === 1 ? "CLASS" : "CLASSES"}</span>
          <p style={{ fontSize: 11.5, color: INK_MUTE, margin: "0 0 6px" }}>
            No widget schema was available for these, so their settings fell back to
            ComfyUI's defaults. Connect a local engine and re-import to map them exactly.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {r.unmapped.map((c) => <Chip key={c} color={C_RISK}>{c}</Chip>)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── the modal ──────────────────────────────────────────────────────────── */

export default function CivitaiImportModal({ projectId }: { projectId?: string | null }) {
  const ws = useWorkspaceStore();
  const [tab, setTab] = useState<Tab>("workflows");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<CivitaiModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<CivitaiModel | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [choices, setChoices] = useState<
    { model: CivitaiModel; version: CivitaiVersion; list: WorkflowCandidate[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const [compat, setCompat] = useState<CompatReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(getToken() ?? "");
  const [tokenSaved, setTokenSaved] = useState(!!getToken());
  const [paste, setPaste] = useState("");
  const [pasteName, setPasteName] = useState("");
  const [over, setOver] = useState(false);
  const [engine, setEngine] = useState<{ ok: boolean; label: string } | null>(null);
  // Civitai pages results by CURSOR, not offset — `nextCursor` is the token
  // for the next 24, `null` once there are no more. `loadingMore` is display
  // only; the actual reentrancy guard is a ref (below), because a rapidly
  // re-firing IntersectionObserver would otherwise race ahead of a state
  // update that has not committed yet.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const objectInfo = useRef<ObjectInfo | null>(null);
  const abort = useRef<AbortController | null>(null);
  // What `items`/`nextCursor` actually belong to — read by `loadMore`, which
  // fires from an observer with no argument of its own to tell it. `q` alone
  // is not this: the user can edit the search box without pressing Search,
  // and loading page 2 of what is now a STALE, unsent query is wrong.
  const activeSearch = useRef<{ tabId: Tab; query: string } | null>(null);
  const loadingMoreRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Is a local engine reachable? Its answer changes what an import can check,
  // so it is probed once when the hub opens rather than at import time —
  // finding out after the fact that nothing was verified is the failure this
  // avoids.
  useEffect(() => {
    if (!isDesktop()) { setEngine({ ok: false, label: "studio cloud" }); return; }
    pingComfy().then(async (s) => {
      setEngine({ ok: s.reachable, label: s.reachable ? `ComfyUI ${s.version ?? "local"}` : "no local engine" });
      if (s.reachable) {
        try { objectInfo.current = await getObjectInfo(); } catch { /* import still works */ }
      }
    });
  }, []);

  const run = useCallback(async (tabId: Tab, query: string) => {
    const def = TABS.find((t) => t.id === tabId);
    if (!def?.types) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    activeSearch.current = { tabId, query };
    setBusy(true); setErr(null); setNextCursor(null);
    try {
      const page = await searchCivitai({
        query, types: def.types, sort: "Most Downloaded", limit: 24,
        token: getToken(), signal: ctl.signal,
      });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      if (!page.items.length) setErr(`Nothing on Civitai matched "${query}".`);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErr(String((e as Error).message || e));
    } finally {
      if (abort.current === ctl) setBusy(false);
    }
  }, []);

  /**
   * Page 2 onward. Shares `abort.current` with `run()` on purpose: starting a
   * NEW search aborts whatever page is still in flight, so a slow "load more"
   * response can never land after a fresh search has already replaced
   * `items` and silently glue unrelated results onto the bottom of it. The
   * `abort.current !== ctl` check after the await is the same belt-and-braces
   * `run()` already uses — an abort rejects the fetch almost always, but nothing
   * here should depend on "almost".
   */
  const loadMore = useCallback(async () => {
    const active = activeSearch.current;
    if (!active || !nextCursor || loadingMoreRef.current) return;
    const def = TABS.find((t) => t.id === active.tabId);
    if (!def?.types) return;
    const ctl = abort.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await searchCivitai({
        query: active.query, types: def.types, sort: "Most Downloaded", limit: 24,
        cursor: nextCursor, token: getToken(), signal: ctl?.signal,
      });
      if (abort.current !== ctl) return;
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErr(String((e as Error).message || e));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [nextCursor]);

  // The scroll container is `.ws-modal-body` (ref'd below); the sentinel sits
  // right after the grid. Re-subscribing on every `nextCursor` change (rather
  // than one long-lived observer) matches the library grid's own reasoning: a
  // sentinel that stays continuously visible across a re-render reports no
  // NEW intersection on its own, which would silently stop paging on a search
  // short enough to never fill the scrollport.
  useEffect(() => {
    const root = bodyRef.current, sentinel = sentinelRef.current;
    if (!root || !sentinel || !nextCursor) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void loadMore();
    }, { root, rootMargin: "500px 0px" });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [nextCursor, loadMore]);

  // Open on something rather than an empty grid: the studio's own model is the
  // most likely search and it demonstrates that the hub works.
  useEffect(() => { void run("workflows", "minimax h3"); }, [run]);

  const store = async (graph: unknown, name: string, meta: Partial<{
    source: CustomWorkflow["source"]; sourceUrl: string; modelId: number; versionId: number; baseModel: string;
  }> = {}) => {
    setImporting(true); setErr(null);
    try {
      const oi = objectInfo.current ?? undefined;
      const conv = toApiGraph(graph, oi);
      if (!Object.keys(conv.api).length) throw new Error(conv.warnings[0]?.message ?? "not a ComfyUI graph");
      const slots = detectSlots(conv.api);
      const issues = validateGraph(conv.api, slots, oi
        ? { classes: new Set(Object.keys(oi)), files: filesFromObjectInfo(oi) }
        : {});

      const compat = analyseGraph(conv.api, await compatEnv(oi ?? null), slots);

      const res = await importWorkflow({
        name, graph, projectId: projectId ?? null, objectInfo: oi,
        source: meta.source ?? "civitai", sourceUrl: meta.sourceUrl ?? null,
        civitaiModelId: meta.modelId ?? null, civitaiVersionId: meta.versionId ?? null,
        baseModel: meta.baseModel ?? null,
      });
      setReport({
        name, slots, issues, warnings: conv.warnings, unmapped: conv.unmapped,
        nodeCount: Object.keys(conv.api).length, saved: res.row, compat,
        checkedAgainst: oi ? `${DEFAULT_COMFY} (${Object.keys(oi).length} node classes)` : null,
      });
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setImporting(false);
    }
  };

  /**
   * A download can hold MORE THAN ONE graph: four of five workflow downloads
   * measured came back as zip archives, and one of those had several .json
   * files in it. When there is a choice the user makes it — picking the
   * biggest, or the first, would silently import the wrong pipeline out of a
   * pack that deliberately ships i2v and t2v side by side.
   */
  const importFromCivitai = async (m: CivitaiModel, v: CivitaiVersion) => {
    const f = workflowFile(v);
    if (!f) { setErr("That version has no workflow file or archive attached."); return; }
    setImporting(true); setErr(null);
    try {
      const found = await fetchWorkflowGraphs(f.downloadUrl, getToken());
      if (found.length > 1) {
        setChoices({ model: m, version: v, list: found });
        setImporting(false);
        return;
      }
      await store(found[0].graph, `${m.name} · ${v.name}`, {
        source: "civitai", sourceUrl: `https://civitai.com/models/${m.id}`,
        modelId: m.id, versionId: v.id, baseModel: v.baseModel ?? undefined,
      });
    } catch (e) {
      setErr(String((e as Error).message || e));
      setImporting(false);
    }
  };

  const takeFile = async (file: File) => {
    setErr(null);
    if (!/\.json$/i.test(file.name)) { setErr(`${file.name} is not a .json workflow.`); return; }
    try {
      const text = await file.text();
      setPaste(text);
      setPasteName((n) => n || file.name.replace(/\.json$/i, ""));
      setTab("paste");
    } catch (e) {
      setErr(`Could not read ${file.name}: ${String((e as Error).message || e)}`);
    }
  };

  const importPasted = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(paste);
    } catch (e) {
      setErr(`That is not valid JSON — ${String((e as Error).message || e).slice(0, 120)}`);
      return;
    }
    await store(parsed, pasteName.trim() || "Pasted workflow", { source: "paste" });
  };

  /**
   * "Will this run here?" WITHOUT importing.
   *
   * A workflow .json is ~100KB, so the honest way to answer is to fetch the
   * real graph and read it — the alternative would be inferring from the
   * version's `baseModel` tag and the author's prose, which is guessing about
   * the one question the graph answers exactly. Nothing is stored: this is a
   * question, not an import.
   */
  const checkFit = async (m: CivitaiModel, v: CivitaiVersion) => {
    const f = workflowFile(v);
    if (!f) { setErr("That version has no workflow file or archive to inspect."); return; }
    setChecking(true); setErr(null); setCompat(null);
    try {
      const found = await fetchWorkflowGraphs(f.downloadUrl, getToken());
      const oi = objectInfo.current ?? undefined;
      const conv = toApiGraph(found[0].graph, oi);
      if (!Object.keys(conv.api).length) throw new Error("that file is not a ComfyUI graph");
      const api = conv.api;
      const r = analyseGraph(api, await compatEnv(oi ?? null), detectSlots(api));
      // An archive of several graphs is checked on its first; say so rather
      // than implying the verdict covers the pack.
      setCompat(found.length > 1
        ? { ...r, headline: `${r.headline} (checked "${found[0].name}" — this download has `
            + `${found.length} graphs and the others may differ.)` }
        : r);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setChecking(false);
    }
  };

  // An import that lands (a report) or forks (a multi-graph archive) replaces
  // the whole hub view, so the detail screen over it has to get out of the way
  // — otherwise the result of the button you just pressed is behind a modal.
  useEffect(() => { if (report || choices) setSel(null); }, [report, choices]);

  const gated = !canDownload();

  return (
    <ModalShell
      icon={<Globe size={15} />}
      title="Civitai hub"
      context={engine
        ? `${engine.ok ? "local engine: " : ""}${engine.label}`
        : "checking for a local engine…"}
      width={1080}
      tall
      onClose={ws.closeModal}
    >
      <div className="ws-modal-body ns-scroll" ref={bodyRef}
           style={{ display: "flex", flexDirection: "column", gap: 12 }}
           onDragOver={(e) => { e.preventDefault(); setOver(true); }}
           onDragLeave={() => setOver(false)}
           onDrop={(e) => {
             e.preventDefault(); setOver(false);
             const f = e.dataTransfer.files?.[0];
             if (f) void takeFile(f);
           }}>

        {report ? (
          <ReportPanel r={report} onClose={() => setReport(null)} />
        ) : choices ? (
          <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="ws-mlabel">{choices.list.length} WORKFLOWS IN THIS DOWNLOAD</span>
            <p style={{ fontSize: 12, color: INK_MUTE, margin: 0 }}>
              The archive holds more than one graph — packs often ship i2v and t2v side
              by side. Pick the one to import.
            </p>
            {choices.list.map((c) => (
              <button key={c.name} className="ws-card" style={{ textAlign: "left", padding: "9px 11px" }}
                      onClick={() => void store(c.graph, `${choices.model.name} · ${c.name.replace(/\.json$/i, "")}`, {
                        source: "civitai", sourceUrl: `https://civitai.com/models/${choices.model.id}`,
                        modelId: choices.model.id, versionId: choices.version.id,
                        baseModel: choices.version.baseModel ?? undefined,
                      }).then(() => setChoices(null))}>
                <span className="mono" style={{ fontSize: 12 }}>{c.name}</span>
                <span style={{ fontSize: 11, color: INK_MUTE, display: "block", marginTop: 2 }}>
                  {(c.graph as { nodes?: unknown[] })?.nodes?.length
                    ?? Object.keys(c.graph as object).length} nodes
                </span>
              </button>
            ))}
            <button className="ws-actbtn" onClick={() => setChoices(null)}>Cancel</button>
          </div>
        ) : (
          <>
            {/* tabs */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {TABS.map((t) => (
                <button key={t.id} className={"ws-pillbtn" + (tab === t.id ? " on" : "")}
                        onClick={() => { setTab(t.id); setSel(null); if (t.types) void run(t.id, q || "minimax h3"); }}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
                          padding: "6px 11px", borderRadius: 9,
                          background: tab === t.id ? "rgba(90,162,255,0.14)" : "rgba(255,255,255,0.04)",
                          color: tab === t.id ? "#5aa2ff" : "#c7cddb",
                          border: `1px solid ${tab === t.id ? "rgba(90,162,255,0.35)" : "rgba(255,255,255,0.07)"}`,
                        }}>
                  {t.icon}{t.label}
                </button>
              ))}
            </div>

            {tab === "paste" ? (
              <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <span className="ws-mlabel">WORKFLOW JSON</span>
                <p style={{ fontSize: 12, color: INK_MUTE, margin: 0 }}>
                  Either format works — ComfyUI's "Save" (UI) or "Save (API Format)". A UI
                  export is converted here, and the original is kept so the graph can be
                  reopened on the canvas. Drop a .json anywhere in this window.
                </p>
                <input className="ws-input" placeholder="Name" value={pasteName}
                       onChange={(e) => setPasteName(e.target.value)} />
                <textarea
                  className="ws-input mono" rows={12} spellCheck={false}
                  placeholder='{"1": {"class_type": "…"}}  or  {"nodes": […], "links": […]}'
                  value={paste} onChange={(e) => setPaste(e.target.value)}
                  style={{ fontSize: 11, lineHeight: 1.5, resize: "vertical" }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="ws-actbtn" onClick={() => fileRef.current?.click()}>
                    <Upload size={12} /> Choose a file
                  </button>
                  <input ref={fileRef} type="file" accept=".json,application/json" hidden
                         onChange={(e) => { const f = e.target.files?.[0]; if (f) void takeFile(f); }} />
                  <div style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: 11, color: INK_MUTE }}>
                    {paste ? `${(paste.length / 1024).toFixed(1)}KB` : ""}
                  </span>
                  <button className="ws-primary" disabled={!paste.trim() || importing}
                          onClick={() => void importPasted()}>
                    {importing ? <Loader2 size={13} className="ws-spin" /> : <FileJson size={13} />}
                    Import
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* search */}
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ position: "relative", flex: 1 }}>
                    <Search size={13} style={{
                      position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
                      color: INK_MUTE, pointerEvents: "none",
                    }} />
                    <input className="ws-input" style={{ paddingLeft: 30, width: "100%" }}
                           placeholder={`Search Civitai ${TABS.find((t) => t.id === tab)?.label.toLowerCase()}…`}
                           value={q} onChange={(e) => setQ(e.target.value)}
                           onKeyDown={(e) => e.key === "Enter" && void run(tab, q)} />
                  </div>
                  <button className="ws-actbtn" onClick={() => void run(tab, q)} disabled={busy}>
                    {busy ? <Loader2 size={12} className="ws-spin" /> : <Search size={12} />} Search
                  </button>
                </div>

                {/* the token gate, stated before it bites */}
                {gated && (
                  <div className="ws-card" style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                    <Key size={14} style={{ color: C_RISK, flex: "none", marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>
                        Downloads need a Civitai API token
                      </div>
                      <p style={{ fontSize: 11.5, color: INK_MUTE, margin: "0 0 7px" }}>
                        Search works without one. Downloads do not — and Civitai answers a
                        tokenless download with <b>200 and its web page</b> rather than an
                        error, so importing one would store an HTML document as a workflow.
                        {!isDesktop() && " The browser build cannot hold a token; use the "
                          + "paste tab, or the desktop app."}
                      </p>
                      {isDesktop() && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <input className="ws-input mono" type="password" style={{ flex: 1, fontSize: 11 }}
                                 placeholder="civitai api token" value={tokenDraft}
                                 onChange={(e) => { setTokenDraft(e.target.value); setTokenSaved(false); }} />
                          <button className="ws-actbtn" disabled={!tokenDraft.trim()}
                                  onClick={() => { setToken(tokenDraft.trim()); setTokenSaved(true); }}>
                            {tokenSaved ? <Check size={12} /> : null} Save
                          </button>
                          <button className="ws-actbtn"
                                  onClick={() => void openExternal("https://civitai.com/user/account")}>
                            <ExternalLink size={12} /> Get one
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {err && (
                  <div className="ws-card" style={{
                    borderColor: "rgba(232,115,74,0.3)", color: "#f0b9a4", fontSize: 12,
                  }}>{err}</div>
                )}

                {/* results — a card opens the full detail screen over this one */}
                {/* `flex: none` matters: the grid is a flex item of a bounded
                    column now that nothing sits beside it, and a shrinkable
                    grid gets its auto rows squashed to fit rather than letting
                    the body scroll — every card clipped to half its height. */}
                <div style={{ display: "grid", gap: 8, minHeight: 260, flex: "0 0 auto",
                              alignContent: "start",
                              gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
                  {items.map((m) => (
                    <ResultCard key={m.id} m={m}
                                onOpen={() => { setErr(null); setCompat(null); setSel(m); }} />
                  ))}
                  {!items.length && !busy && (
                    <div className="ws-empty" style={{ gridColumn: "1/-1" }}>
                      Search Civitai to get started.
                    </div>
                  )}
                </div>

                {/* The load-more sentinel. It has to keep existing in the DOM
                    even with nothing to show — an empty div is what the
                    IntersectionObserver above is watching — so it renders for
                    the WHOLE tail of a result set, not only while there's a
                    next page, and just swaps its content. */}
                {items.length > 0 && (
                  <div ref={sentinelRef} style={{
                    display: "flex", justifyContent: "center", padding: "8px 0 2px",
                  }}>
                    {loadingMore ? (
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center",
                                     fontSize: 11.5, color: INK_MUTE }}>
                        <Loader2 size={12} className="ws-spin" /> Loading more…
                      </span>
                    ) : !nextCursor ? (
                      <span style={{ fontSize: 11, color: INK_MUTE }}>
                        That's everything Civitai has for this search.
                      </span>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {over && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(90,162,255,0.1)",
            border: "2px dashed rgba(90,162,255,0.5)", borderRadius: 20,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, pointerEvents: "none", zIndex: 5,
          }}>Drop a workflow .json</div>
        )}

        {sel && tab !== "paste" && (
          <CivitaiDetailModal
            model={sel} kind={tab} importing={importing} error={err}
            compat={compat} checking={checking}
            onCheck={(m, v) => void checkFit(m, v)}
            onImport={(m, v) => void importFromCivitai(m, v)}
            engineOk={engine?.ok ?? false}
            onClose={() => { setSel(null); setCompat(null); }}
          />
        )}
      </div>
    </ModalShell>
  );
}
