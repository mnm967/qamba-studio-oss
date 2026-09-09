import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Loader2, Music, Sparkles, Upload } from "lucide-react";
import V2Shell from "../design/V2Shell";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { loadProject, mainEpisode } from "../lib/db/projects";
import { registerAsset } from "../lib/db/assets";
import { probedUploadMeta } from "../lib/mediaProbe";
import { enqueueJob } from "../lib/db/jobs";
import { supabase } from "../lib/supabase";
import { availableBackends } from "../lib/director";
import { useIsAdmin } from "../lib/auth";
import { useByok } from "../hooks/useByok";
import { buildPersona } from "../../director/personas.js";
import { uploadMedia } from "../lib/upload";
import { getWizardPageDraft, setWizardPageDraft, clearWizardPageDraft } from "../lib/draftStore";
import type { Job } from "../lib/db/types";
import "../styles/director.css";

/** `[mm:ss.xx] line` (or `mm:ss line`) -> timed lyrics; t1 = next t0. */
export function parseLyrics(text: string, fallbackGap = 4000) {
  const out: { t0: number; t1: number; text: string }[] = [];
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*\[?(\d+):(\d{1,2}(?:\.\d+)?)\]?\s+(.+)$/);
    if (!m) continue;
    out.push({ t0: Math.round((+m[1] * 60 + +m[2]) * 1000), t1: 0, text: m[3].trim() });
  }
  out.sort((a, b) => a.t0 - b.t0);
  for (let i = 0; i < out.length; i++) {
    out[i].t1 = i + 1 < out.length ? out[i + 1].t0 : out[i].t0 + fallbackGap;
  }
  return out;
}

export function beatsGrid(bpm: number, offsetMs: number, durationMs: number) {
  if (!bpm || bpm < 30 || bpm > 300) return undefined;
  const step = 60000 / bpm;
  const beats: number[] = [];
  for (let t = offsetMs; t <= durationMs; t += step) beats.push(Math.round(t));
  return beats;
}

export default function WizardPage() {
  const { pid } = useParams<{ pid: string }>();
  const { data: project } = useLiveQuery(() => loadProject(pid!), ["projects"], [pid]);

  const isAdmin = useIsAdmin();
  const { keyed: byokKeys } = useByok();
  const initialDraft = useMemo(() => getWizardPageDraft(pid), [pid]);
  const [logline, setLogline] = useState(initialDraft.logline ?? "");
  const [notes, setNotes] = useState(initialDraft.notes ?? "");
  const [lyricsText, setLyricsText] = useState(initialDraft.lyricsText ?? "");

  const activePidRef = useRef(pid);
  useEffect(() => {
    activePidRef.current = pid;
    const d = getWizardPageDraft(pid);
    setLogline(d.logline ?? "");
    setNotes(d.notes ?? "");
    setLyricsText(d.lyricsText ?? "");
  }, [pid]);

  useEffect(() => {
    if (activePidRef.current !== pid) return;
    setWizardPageDraft(pid, { logline, notes, lyricsText });
  }, [logline, notes, lyricsText, pid]);

  const [durationS, setDurationS] = useState(60);
  const [tier, setTier] = useState<1 | 2>(2);
  const [backend, setBackend] = useState("openai-compat");
  const [audio, setAudio] = useState<{ assetId: string; name: string; durationMs?: number } | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [bpm, setBpm] = useState<string>("");
  const [offsetMs, setOffsetMs] = useState<string>("0");
  const [jobId, setJobId] = useState<string | null>(null);
  const [launchErr, setLaunchErr] = useState<string | null>(null);

  const isMV = project?.medium === "music_video";
  const effectiveBackend = backend;
  const lyrics = useMemo(() => parseLyrics(lyricsText), [lyricsText]);

  const { data: job } = useLiveQuery(
    async () => {
      if (!jobId) return null;
      const { data } = await supabase.from("jobs").select("*").eq("id", jobId).maybeSingle();
      return data as Job | null;
    },
    ["jobs"], [jobId]
  );
  const onAudioFile = async (file: File) => {
    setUploadPct(0);
    try {
      const key = `audio/${pid}/${Date.now()}_${file.name.replace(/[^\w.-]+/g, "_")}`;
      await uploadMedia(file, key, (p: number) => setUploadPct(p));
      const asset = await registerAsset({
        b2_key: key, kind: "audio", project_id: pid,
        content_type: file.type || "audio/mpeg", bytes: file.size, tags: ["master-track"],
        ...(await probedUploadMeta(file)),   // don't wait on the pod for a length
      });
      await enqueueJob({ kind: "asset_ingest", lane: "cpu", priority: 60, payload: { asset_id: asset.id } });
      setAudio({ assetId: asset.id, name: file.name });
    } catch (e) {
      alert(`upload failed: ${e}`);
    } finally {
      setUploadPct(null);
    }
  };

  const launch = async () => {
    if (!pid || !project || !logline.trim()) return;
    setLaunchErr(null);
    try {
      const ep = await mainEpisode(pid);
      const durationMs = durationS * 1000;
      const audioMeta = isMV
        ? {
            ...(bpm ? { bpm: +bpm } : {}),
            ...(beatsGrid(+bpm, +offsetMs || 0, durationMs) ? { beats_ms: beatsGrid(+bpm, +offsetMs || 0, durationMs) } : {}),
            ...(lyrics.length ? { lyrics } : {}),
          }
        : undefined;
      const j = await enqueueJob({
        kind: "llm_task", lane: "llm", priority: 20,
        project_id: pid, episode_id: ep?.id, model_id: effectiveBackend,
        payload: {
          task: "plan_storyboard", project_id: pid, episode_id: ep?.id,
          brief: {
            logline: logline.trim(), notes: notes.trim() || undefined,
            duration_target_ms: durationMs,
            audio_asset_id: audio?.assetId ?? null,
            ...(audioMeta ? { audio_meta: audioMeta } : {}),
          },
          tier, auto_launch: tier === 1, backend: effectiveBackend,
          llm_model: "gpt-5.6-terra",
          image_model: "krea2",
          persona: buildPersona({
            medium: project.medium, genre: project.genre, style: project.style,
          }),
        },
      });
      setJobId(j.id);
      clearWizardPageDraft(pid);
    } catch (e) {
      setLaunchErr(String((e as Error).message || e));
    }
  };

  if (jobId) {
    const failed = job?.status === "error";
    // Same trap as WizardModal's step 2: a canceled job is terminal and no
    // worker will ever claim it again, so treating it as "not finished yet"
    // spins on "waiting for the worker" forever.
    const canceled = job?.status === "canceled";
    const canceling = job?.status === "running" && job.cancel_requested;
    const done = job?.status === "done";
    return (
      <V2Shell title="One-shot wizard" eyebrow={project?.title ?? ""} backTo={`/project/${pid}`}>
        <div className="dir-card wizprogress">
          {!done && !failed && !canceled && (
            <>
              <Loader2 className="spin" size={18} />
              <div className="wiz-status">
                {canceling
                  ? "canceling — waiting for the worker to stop this run"
                  : job?.status === "running"
                    ? job?.progress_note || "planning…"
                    : "waiting for the worker — the studio cloud must be up"}
              </div>
              {!canceling && job?.progress != null && job.progress > 0 && (
                <div className="wiz-bar"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
              )}
            </>
          )}
          {failed && (
            <>
              <div className="wiz-status err">Planning failed: {job?.error_msg}</div>
              <button className="dir-ghost" onClick={() => setJobId(null)}>Back to brief</button>
            </>
          )}
          {canceled && (
            <>
              <div className="wiz-status">Planning canceled — this run stopped before the storyboard was finished.</div>
              <button className="dir-ghost" onClick={() => setJobId(null)}>Back to brief</button>
            </>
          )}
          {done && (
            <>
              <div className="wiz-status ok">
                Storyboard ready{tier === 1 ? " — ref sheets and the full render are queued." : "."}
              </div>
              <div className="dir-row">
                <Link className="dir-cta" to={`/project/${pid}/ep/${job?.episode_id}/storyboard`}>
                  {tier === 1 ? "Watch progress" : "Review storyboard"}
                </Link>
                <Link className="dir-ghost" to={`/project/${pid}/bible`}>Review cast & world</Link>
              </div>
              {tier === 2 && (
                <div className="wiz-note">
                  Review path: confirm cast in the Bible (generate ref sheets), tweak scenes in the
                  storyboard, then hit Launch render there.
                </div>
              )}
            </>
          )}
        </div>
      </V2Shell>
    );
  }

  return (
    <V2Shell title="One-shot wizard" eyebrow={project?.title ?? ""} backTo={`/project/${pid}`}>
      <div className="dir-card wizform">
        <label className="dir-label">What are we making?</label>
        <textarea
          className="dir-input" rows={3} value={logline} autoFocus
          placeholder={isMV
            ? "A neon-soaked anime music video: a runner races dawn across rooftops while the city wakes…"
            : "Logline — who wants what, against what, where…"}
          onChange={(e) => setLogline(e.target.value)}
        />
        <label className="dir-label">Directing notes (optional)</label>
        <textarea
          className="dir-input" rows={2} value={notes}
          placeholder="Palette, references, must-have shots, pacing…"
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="dir-row">
          <label className="dir-label">Target length: <b>{durationS}s</b></label>
          <input
            type="range" min={15} max={180} step={5} value={durationS}
            onChange={(e) => setDurationS(+e.target.value)} style={{ flex: 1 }}
          />
        </div>

        {isMV && (
          <div className="wiz-audio">
            <label className="dir-label"><Music size={12} /> Master track</label>
            {audio ? (
              <div className="dir-row"><span className="dir-tag">{audio.name}</span>
                <button className="dir-ghost" onClick={() => setAudio(null)}>remove</button>
              </div>
            ) : (
              <label className="dir-drop">
                <Upload size={14} />
                {uploadPct != null ? ` Uploading ${Math.round(uploadPct * 100)}%…` : " Drop / pick the song (mp3, wav)"}
                <input
                  type="file" accept="audio/*" hidden
                  onChange={(e) => e.target.files?.[0] && onAudioFile(e.target.files[0])}
                />
              </label>
            )}
            <div className="dir-row">
              <input className="dir-input sm" placeholder="BPM" value={bpm}
                     onChange={(e) => setBpm(e.target.value.replace(/\D/g, ""))} />
              <input className="dir-input sm" placeholder="First beat offset (ms)" value={offsetMs}
                     onChange={(e) => setOffsetMs(e.target.value.replace(/[^\d-]/g, ""))} />
            </div>
            <label className="dir-label">Timed lyrics (optional) — one per line: [mm:ss.x] words</label>
            <textarea
              className="dir-input mono" rows={4} value={lyricsText}
              placeholder={"[00:12.5] I burned the map that led me home\n[00:16.0] followed sparks into the smoke"}
              onChange={(e) => setLyricsText(e.target.value)}
            />
            {lyricsText && <div className="wiz-note">{lyrics.length} timed lines parsed</div>}
          </div>
        )}

        <div className="dir-row wiz-tier">
          <button className={"dir-chip" + (tier === 2 ? " on" : "")} onClick={() => setTier(2)}>
            Review storyboard first
          </button>
          <button className={"dir-chip" + (tier === 1 ? " on" : "")} onClick={() => setTier(1)}>
            <Sparkles size={12} /> Full auto (one-shot)
          </button>
        </div>
        <div className="dir-row">
          <select className="dir-select" value={effectiveBackend}
                  onChange={(e) => setBackend(e.target.value)}>
            {availableBackends(byokKeys, { admin: isAdmin })
              .map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </div>
        {tier === 1 && (
          <div className="wiz-note">
            Full auto plans the storyboard, generates ref sheets for new characters and
            environments, then renders every block.
          </div>
        )}
        {launchErr && <div className="wiz-status err">{launchErr}</div>}
        <button className="dir-cta big" disabled={!logline.trim() || uploadPct != null} onClick={launch}>
          <Sparkles size={15} /> {tier === 1 ? "Make the whole thing" : "Plan the storyboard"}
        </button>
      </div>
    </V2Shell>
  );
}
