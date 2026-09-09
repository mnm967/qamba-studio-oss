// Project settings: the style guide and the default models every generation
// in this project starts from.
//
// The style guide is the important field. `projects.style` is one token
// ("anime") and a token cannot stop a project drifting between cel shading,
// rendered 3D and photography — the guide is the paragraph that does, and it
// gets prepended to reference sheets, stills and block prompts alike.
import { useEffect, useState } from "react";
import { ChevronDown, Globe, HardDrive, Loader2, Settings2 } from "lucide-react";
import ModalShell from "./ModalShell";
import { localProjectBytes } from "../../lib/localPlane";
import Dropdown from "../ui/Dropdown";
import { LoraStack, styleLoras, validLoras } from "../ui/ImageModelPicker";
import TieredModelMenu, { type Quality } from "../ui/TieredModelMenu";
import { useMarkedCatalog } from "../../hooks/useSheetModels";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import { useVideoLoras } from "../../hooks/useVideoLoras";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { loadCatalog } from "../../lib/catalog";
import {
  appDefaults, resolveDefaults, saveProjectSettings, setAppDefaults,
  STYLE_PRESETS, type ProjectSettings,
} from "../../lib/projectSettings";
import type { ModelCatalogRow, Project } from "../../lib/db/types";

export default function ProjectSettingsModal({ projectId }: { projectId: string }) {
  const ws = useWorkspaceStore();
  const [note, setNote] = useState<string | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** write the same choice to localStorage so the next project inherits it */
  const [alsoGlobal, setAlsoGlobal] = useState(true);
  const engine = useLocalEngine();

  const { data, error: loadError, reload } = useLiveQuery(async () => {
    // The two are independent — sequential awaits doubled the open time.
    const [{ data: project }, models] = await Promise.all([
      supabase.from("projects").select("*").eq("id", projectId).single(),
      loadCatalog(),
    ]);
    return { project: project as Project, models };
  }, [], [projectId]);

  const settings = (data?.project.settings ?? {}) as ProjectSettings;
  // ABOVE the early return, like `videoRow` below it: a hook cannot sit behind
  // one. Returns [] in the browser, so it concatenates unconditionally.
  // The catalogue as this machine sees it: the rows a key of yours re-enables,
  // plus the image rows its own pipeline can render marked onto the local
  // tier. Shared with the wizard and the new-project form for the reason the
  // note above gives — three surfaces, two fields, one list.
  const marked = useMarkedCatalog(data?.models);
  // ABOVE the loading early-return: a hook cannot sit behind one. Wrapped so a
  // hub adapter downloaded to this machine is a legitimate pick for an episode
  // that renders here — `styleLoras`/`validLoras` read the row's own table.
  const videoRow = useVideoLoras(
    [...(data?.models ?? []), ...engine.rows].find(
      (m) => m.kind === "video"
        && m.id === resolveDefaults((data?.project.settings ?? {}) as ProjectSettings).video_model));
  useEffect(() => { if (data && guide == null) setGuide(settings.style_guide ?? ""); },
            [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) {
    return (
      <ModalShell width={860} maxH={720} tall z={93}
                  icon={<Settings2 size={16} />} title="Generation settings"
                  loading loadingLabel="Loading project…" loadError={loadError} />
    );
  }
  const eff = resolveDefaults(settings);
  const app = appDefaults();
  // Catalog plus this machine's own engine plus the rows a key of YOURS
  // re-enables, same as the library's generate dock, the director's header
  // chips and the new-project form — these surfaces write the same two fields,
  // so one of them offering a plane the others cannot name is a picker showing
  // a raw `local:…` id back. The byok half was missing, which is not a hidden
  // row but a false sentence: a hosted model you hold the key for read "add
  // your openai key" here while the composer rendered on it.
  const all = [...marked, ...engine.rows];
  const imageModels = all.filter((m) => m.kind === "image");
  const videoModels = all.filter((m) => m.kind === "video");
  const loras = styleLoras(imageModels.find((m) => m.id === eff.image_model));
  const vLoras = styleLoras(videoRow);

  const save = async (patch: Partial<ProjectSettings>, label: string) => {
    setBusy(true);
    try {
      await saveProjectSettings(projectId, patch);
      if (alsoGlobal) setAppDefaults(patch);
      setNote(`${label} saved${alsoGlobal ? " · also the new default for new projects" : ""}.`);
      reload();
    } catch (e) {
      setNote(`Could not save: ${String((e as Error).message || e).slice(0, 110)}`);
    } finally { setBusy(false); }
  };

  const ModelPicker = ({ kindLabel, models, value, onPick, quality, onQuality }: {
    kindLabel: string; models: ModelCatalogRow[]; value: string;
    onPick: (id: string) => void;
    quality?: Quality | null; onQuality?: (q: Quality) => void;
  }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="ws-mlabel" style={{ marginBottom: 6 }}>{kindLabel}</div>
      <Dropdown width={330}
        trigger={({ toggle }) => (
          <button className="ws-ghost" onClick={toggle}
                  style={{ height: 40, width: "100%", justifyContent: "space-between", padding: "0 13px" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {models.find((m) => m.id === value)?.display_name ?? value}
            </span>
            <ChevronDown size={13} />
          </button>
        )}>
        {(close) => (
          // The same grouped menu the library and every other surface uses —
          // this was a flat "Available / Unavailable" split that could not say
          // a row was hosted.
          <TieredModelMenu models={models} value={value} close={close} onPick={onPick}
                           quality={quality} onQuality={onQuality} />
        )}
      </Dropdown>
    </div>
  );

  return (
    <ModalShell
      width={860} maxH={720} tall z={93}
      icon={<Settings2 size={16} />}
      title={`${data.project.title} · generation settings`}
      context="Applies to every reference, still and block rendered in this project"
      footer={<>
        <label className="sum" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={alsoGlobal} onChange={(e) => setAlsoGlobal(e.target.checked)} />
          <Globe size={12} /> also make these my defaults for new projects
        </label>
        {note && <span className="mono" style={{ fontSize: 12, color: "#6fd08c" }}>{note}</span>}
        <button className="ws-ghost" onClick={ws.closeModal}>Done</button>
      </>}
    >
      <div className="ns-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto",
                                          display: "flex", flexDirection: "column", gap: 16,
                                          padding: "0 22px 16px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Style guide</span>
            <span style={{ flex: 1 }} />
            {busy && <Loader2 size={13} className="ns-spin" style={{ color: "#5e6678" }} />}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 9 }}>
            {STYLE_PRESETS.map((p) => (
              <button key={p.id} className="ws-pill"
                      title={p.guide}
                      onClick={() => { setGuide(p.guide); void save({ style_guide: p.guide }, p.label); }}>
                <img src={p.image} alt={p.label} style={{ width: 18, height: 18, borderRadius: "50%", objectFit: "cover", marginLeft: -2 }} />{p.label}
              </button>
            ))}
          </div>
          <textarea className="ws-input ns-scroll" rows={7} value={guide ?? ""}
                    placeholder="Describe the look this project holds to — medium, shading, lighting, lens, what it must never look like. Prepended to every generation prompt."
                    style={{ fontSize: 13.5, lineHeight: 1.7, padding: "14px 16px", borderRadius: 18 }}
                    onChange={(e) => setGuide(e.target.value)}
                    onBlur={() => {
                      if ((guide ?? "") !== (settings.style_guide ?? "")) {
                        void save({ style_guide: guide ?? "" }, "Style guide");
                      }
                    }} />
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#5e6678", marginTop: 7 }}>
            Say what it must <i>not</i> look like as well as what it should — "no 3D shading,
            no photographic skin" is what stops an anime project drifting halfway to render.
            Leave it empty to fall back to the project's <span className="mono">style</span> tag
            ({data.project.style || "unset"}) alone.
          </div>
        </div>

        {/* WHERE THIS PROJECT LIVES, said in the one place someone goes to ask
            about the project. There is one answer on this build — the app's
            own folder on this disk — so it is a fact rather than a control,
            and the size is the part worth knowing. */}
        <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <HardDrive size={14} /> Storage
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ flex: 1, fontSize: 13, color: "#c8cfdb" }}>
              On this computer
              <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: "#5e6678" }}>
                {fmtBytes(localProjectBytes(projectId))} of media on disk
              </span>
            </span>
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#5e6678" }}>
            Rows and media live in this app&rsquo;s own folder. Nothing is uploaded
            anywhere and nothing is backing it up — copy that folder if you want
            one.
          </div>
        </div>

        <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Default models</span>
          <div style={{ display: "flex", gap: 14 }}>
            <ModelPicker kindLabel="Images (references, stills)" models={imageModels}
                         value={eff.image_model}
                         onPick={(id) => void save({ image_model: id }, "Image model")}
                         quality={eff.image_quality}
                         onQuality={(q) => void save({ image_quality: q }, "Image quality")} />
            <ModelPicker kindLabel="Video (blocks)" models={videoModels}
                         value={eff.video_model}
                         onPick={(id) => void save({ video_model: id }, "Video model")} />
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#5e6678" }}>
            {settings.image_model || settings.video_model
              ? "Set on this project — new projects use your defaults below."
              : app.image_model || app.video_model
                ? "Inherited from your defaults; picking here overrides for this project only."
                : "Built-in defaults. Pick anything here to pin it."}
            {" "}A model with references attached falls back to one that can accept them —
            Krea has no reference path, so ref-carrying jobs route to Klein.
          </div>

          {/* LoRAs are a property of the MODEL, so each stack lives with its
              own: the catalog says which keys are installed, the worker maps
              each key to a file. What is set here is the project's default.
              Image and video are separate fields because validLoras prunes any
              pick the selected model doesn't declare — one shared field would
              empty itself every time you switched between the two. */}
          {loras.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8,
                          borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 12 }}>
              <span className="ws-mlabel">LoRA stack</span>
              <LoraStack model={imageModels.find((m) => m.id === eff.image_model)}
                         value={validLoras(imageModels.find((m) => m.id === eff.image_model),
                                           eff.image_loras)}
                         onChange={(v) => void save({ image_loras: v }, "LoRA stack")} />
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#5e6678" }}>
                Applied in order to every reference and still on{" "}
                {imageModels.find((m) => m.id === eff.image_model)?.display_name ?? eff.image_model}.
                Local weights only — a hosted model ignores them.
              </div>
            </div>
          )}

          {vLoras.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8,
                          borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 12 }}>
              <span className="ws-mlabel">Video LoRA stack</span>
              <LoraStack model={videoRow}
                         value={validLoras(videoRow, eff.video_loras)}
                         onChange={(v) => void save({ video_loras: v }, "Video LoRA stack")} />
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#5e6678" }}>
                Carried onto every block of an episode queued from the wizard, so
                the look cannot change shot to shot. Adapters you downloaded from
                the hub are offered here too, and render on this machine.
              </div>
            </div>
          )}
        </div>

      </div>
    </ModalShell>
  );
}

function fmtBytes(n: number): string {
  if (!n) return "no media yet";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
