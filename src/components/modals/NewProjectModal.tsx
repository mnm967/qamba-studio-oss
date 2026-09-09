import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Edit3,
  Film,
  Music,
  Plus,
  Sparkles,
  Tv,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from "lucide-react";
import Dropdown from "../ui/Dropdown";
import TieredModelMenu, { TierIcon, type Quality } from "../ui/TieredModelMenu";
import { useMarkedCatalog } from "../../hooks/useSheetModels";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { loadCatalog } from "../../lib/catalog";
import { createProject, mainEpisode } from "../../lib/db/projects";
import { tierOf, unrunnableHere } from "../../lib/localModels";
import { resolveDefaults, STYLE_PRESETS, StylePreset } from "../../lib/projectSettings";
import type { Medium, ModelCatalogRow } from "../../lib/db/types";

const MEDIUMS: {
  id: Medium;
  label: string;
  badge: string;
  desc: string;
  icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>;
}[] = [
  {
    id: "music_video",
    label: "Music Video",
    badge: "Track + Cuts",
    desc: "Synchronized audio timeline with rhythmic beats & shot cuts",
    icon: Music,
  },
  {
    id: "film",
    label: "Film",
    badge: "Cinematic Arc",
    desc: "Single cohesive cinematic narrative with scene breakdowns",
    icon: Film,
  },
  {
    id: "series",
    label: "Series",
    badge: "Episodic",
    desc: "Multi-episode season structure with persistent bible entries",
    icon: Tv,
  },
];

const ASPECTS: { id: string; label: string; ratio: string; w: number; h: number }[] = [
  { id: "16:9", label: "16:9", ratio: "Widescreen", w: 28, h: 16 },
  { id: "9:16", label: "9:16", ratio: "Vertical", w: 16, h: 28 },
  { id: "2.39:1", label: "2.39:1", ratio: "Anamorphic", w: 32, h: 14 },
  { id: "4:3", label: "4:3", ratio: "Classic", w: 24, h: 18 },
  { id: "1:1", label: "1:1", ratio: "Square", w: 20, h: 20 },
];

const GENRE_TAGS = [
  "Cyberpunk",
  "Sci-Fi",
  "Anime Mecha",
  "Dark Fantasy",
  "Synthwave",
  "Neo-Noir",
  "Cinematic Drama",
  "Surreal",
  "Retro 80s",
  "Lo-Fi Chill",
];

/**
 * The two model defaults, and whether they can run where this project is going.
 *
 * ITS OWN COMPONENT SO ITS DATA HOOKS RUN ONLY WHILE THE MODAL IS OPEN.
 * `<NewProjectModal/>` is mounted unconditionally by the workspace and returns
 * null when shut, so a `useLocalEngine()` in the body would walk the engine's
 * model directories every 8 seconds for the whole session to serve a form
 * almost nobody has open. The picks themselves stay in the parent, where they
 * survive the scrim-click that closes this thing by accident.
 *
 * The list is the catalog plus this machine's own engine plus the rows a key
 * of yours re-enables — the same three sources the library's generate dock and
 * project settings use. A picker here that offered a plane those cannot name
 * would be a project created against a model its own settings screen shows as
 * unavailable.
 */
function ModelDefaults({
  image, video, quality, onImage, onVideo, onQuality,
}: {
  image: string; video: string; quality: Quality;
  onImage: (id: string) => void;
  onVideo: (id: string) => void;
  onQuality: (q: Quality) => void;
}) {
  const engine = useLocalEngine();
  const { data: catalog } = useLiveQuery(() => loadCatalog(), [], []);
  // `useMarkedCatalog` is the catalogue plus the rows a key of yours
  // re-enables, with the image rows this machine's own pipeline can render
  // marked onto the local tier — shared with the wizard and project settings,
  // which write the same two fields. `engine.rows` (the `local:` ids) are this
  // surface's own addition: a composer still renders on one, and a project
  // default is for those as much as for a sheet.
  const marked = useMarkedCatalog(catalog);
  const all = useMemo(() => [...marked, ...engine.rows], [marked, engine.rows]);
  const imageRow = all.find((m) => m.id === image);
  const videoRow = all.find((m) => m.id === video);

  // A MODEL NOBODY HERE CAN RUN, said where the pairing is chosen. The
  // built-in defaults name models the cloud build rendered on its own GPUs, so
  // without this the commonest answer is a project whose every render is
  // refused minutes later by `enqueueJob` rather than at the moment it was
  // chosen.
  const stranded = [imageRow, videoRow]
    .filter((m): m is ModelCatalogRow => unrunnableHere(m));

  return (
    <>
      <div style={{ display: "flex", gap: 10 }}>
        <ModelField label="Images" hint="references, stills, panels"
                    models={all.filter((m) => m.kind === "image")}
                    value={image} onPick={onImage}
                    quality={quality} onQuality={onQuality} />
        <ModelField label="Video" hint="blocks, shots, extensions"
                    models={all.filter((m) => m.kind === "video")}
                    value={video} onPick={onVideo} />
      </div>
      {stranded.length > 0 && (
        <div className="ws-newproj-model-warn">
          <AlertTriangle size={12} style={{ flex: "none", marginTop: 1 }} />
          <span>
            Nothing on this machine can run{" "}
            <b>{stranded.map((m) => m.display_name).join(", ")}</b>. Pick a model
            under “on this machine”, or one you hold the provider key for.
          </span>
        </div>
      )}
    </>
  );
}

/** One picker. The tier icon leads the CLOSED control as well as the menu:
 *  shut, the studio's GPT Image 2 and the one on your own key are the same
 *  six words and a different bill. */
function ModelField({ label, hint, models, value, onPick, quality, onQuality }: {
  label: string; hint: string;
  models: ModelCatalogRow[]; value: string;
  onPick: (id: string) => void;
  quality?: Quality; onQuality?: (q: Quality) => void;
}) {
  const row = models.find((m) => m.id === value);
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="ws-newproj-label-row" style={{ marginBottom: 6 }}>
        <span className="ws-mlabel">{label}</span>
        <span className="ws-newproj-hint">{hint}</span>
      </div>
      <Dropdown width={330} className="ws-newproj-model-anchor"
        trigger={({ toggle }) => (
          <button type="button" className="ws-ghost ws-newproj-model-btn" onClick={toggle}>
            <TierIcon tier={row ? tierOf(row) : null} />
            <span className="ws-newproj-model-name">
              {/* The id is the honest fallback while the catalog is still in
                  flight, or when there is no session to read it with — the
                  same thing project settings shows. */}
              {row?.display_name ?? value}
            </span>
            <ChevronDown size={13} style={{ flex: "none" }} />
          </button>
        )}>
        {(close) => (models.length ? (
          <TieredModelMenu models={models} value={value} close={close} onPick={onPick}
                           quality={quality} onQuality={onQuality} />
        ) : (
          <div className="gd-tierblurb" style={{ padding: "10px 12px" }}>
            No {label.toLowerCase()} models to choose from yet — install one, or
            add a provider key, in the engine window.
          </div>
        ))}
      </Dropdown>
    </div>
  );
}

export default function NewProjectModal() {
  const ws = useWorkspaceStore();
  const nav = useNavigate();

  const [title, setTitle] = useState("");
  const [medium, setMedium] = useState<Medium>("music_video");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("anime");
  const [isCustomStyle, setIsCustomStyle] = useState(false);
  const [customStyleName, setCustomStyleName] = useState("");
  const [styleGuide, setStyleGuide] = useState(
    () => STYLE_PRESETS.find((p) => p.id === "anime")?.guide ?? ""
  );
  const [showGuideEditor, setShowGuideEditor] = useState(false);
  const [aspect, setAspect] = useState("16:9");
  const [logline, setLogline] = useState("");
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // NULL MEANS INHERIT, which is what the stored setting itself means: a
  // project with no `image_model` follows your app default for the rest of its
  // life, so writing the resolved value here would pin every new project at
  // creation and quietly make "also make these my defaults for new projects"
  // reach nothing that already exists. Only a deliberate pick is written.
  const [imagePick, setImagePick] = useState<string | null>(null);
  const [videoPick, setVideoPick] = useState<string | null>(null);
  const [qualityPick, setQualityPick] = useState<Quality | null>(null);

  const open = ws.modal?.kind === "newProject";
  // Re-read on every OPEN rather than once at mount: this component lives for
  // the whole session (it renders null when shut), so a default changed in
  // project settings meanwhile would otherwise never be seen here.
  const inherited = useMemo(() => resolveDefaults(null), [open]);

  if (!open) return null;

  const currentPreset = STYLE_PRESETS.find((p) => p.id === selectedPresetId);

  const handleSelectPreset = (preset: StylePreset) => {
    setSelectedPresetId(preset.id);
    setIsCustomStyle(false);
    setStyleGuide(preset.guide);
  };

  const handleSelectCustom = () => {
    setIsCustomStyle(true);
    if (!customStyleName) {
      setCustomStyleName("Custom Look");
    }
  };

  const toggleGenre = (g: string) => {
    setSelectedGenres((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]
    );
  };

  const handleCreate = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);

    const styleName = isCustomStyle
      ? customStyleName.trim() || "custom"
      : currentPreset?.id || "anime";

    try {
      const p = await createProject({
        medium,
        title: title.trim(),
        style: styleName,
        aspect,
        logline: logline.trim() || undefined,
        genre: selectedGenres.length > 0 ? selectedGenres : undefined,
        settings: {
          style_guide: styleGuide.trim(),
          aspect,
          ...(imagePick ? { image_model: imagePick } : {}),
          ...(videoPick ? { video_model: videoPick } : {}),
          ...(qualityPick ? { image_quality: qualityPick } : {}),
        },
      });

      const ep = await mainEpisode(p.id);
      setTitle("");
      setLogline("");
      setSelectedGenres([]);
      ws.openModal({ kind: "wizard", projectId: p.id });
      nav(ep ? `/project/${p.id}/ep/${ep.id}/timeline` : `/project/${p.id}`);
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="ws-scrim"
      style={{ zIndex: 200 }}
      onClick={(e) => e.target === e.currentTarget && ws.closeModal()}
    >
      <div
        className="ws-modal ns-l3 ns-rise ws-newproj-modal"
        style={{ width: 880, maxWidth: "95vw", maxHeight: "90vh" }}
      >
        {/* Modal Header */}
        <div className="ws-modal-head ws-newproj-head">
          <span className="ws-modal-ico ws-newproj-ico">
            <Plus size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ws-modal-t ws-newproj-title">Create New Project</div>
            <div className="ws-modal-c ws-newproj-sub">
              medium · art style · canvas ratio · story logline
            </div>
          </div>
          <button className="ws-icobtn lg" onClick={ws.closeModal} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="ws-modal-body ns-scroll ws-newproj-body">
          {/* 1. Title Input */}
          <div className="ws-newproj-section">
            <div className="ws-newproj-label-row">
              <label className="ws-mlabel" htmlFor="project-title-input">
                Project Title <span className="ws-newproj-req">*</span>
              </label>
              <span className="ws-newproj-hint">Press Enter ↵ to create when ready</span>
            </div>
            <div className="ws-newproj-input-wrap">
              <input
                id="project-title-input"
                className="ws-input ws-newproj-title-input"
                autoFocus
                placeholder="e.g. Cyberpunk Odyssey, Ghost City, Astral Bloom…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && title.trim()) {
                    e.preventDefault();
                    handleCreate();
                  }
                }}
              />
              {title && (
                <button
                  className="ws-newproj-input-clear"
                  onClick={() => setTitle("")}
                  title="Clear"
                  type="button"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* 2. Medium Selection */}
          <div className="ws-newproj-section">
            <div className="ws-mlabel" style={{ marginBottom: 9 }}>
              Format & Medium
            </div>
            <div className="ws-newproj-medium-grid">
              {MEDIUMS.map((m) => {
                const Icon = m.icon;
                const isSelected = medium === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`ws-newproj-medium-card ${isSelected ? "selected" : ""}`}
                    onClick={() => setMedium(m.id)}
                  >
                    <div className="ws-newproj-medium-top">
                      <div className="ws-newproj-medium-icon">
                        <Icon size={20} />
                      </div>
                      <span className="ws-newproj-medium-badge">{m.badge}</span>
                      {isSelected && (
                        <div className="ws-newproj-check-badge">
                          <Check size={12} />
                        </div>
                      )}
                    </div>
                    <div className="ws-newproj-medium-label">{m.label}</div>
                    <div className="ws-newproj-medium-desc">{m.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Visual Style Art Direction (Using Sidebar Preset Images) */}
          <div className="ws-newproj-section">
            <div className="ws-newproj-label-row" style={{ marginBottom: 9 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="ws-mlabel">Visual Art Direction & Style</span>
                <span className="ws-newproj-count-badge">{STYLE_PRESETS.length} presets</span>
              </div>
              <button
                type="button"
                className="ws-newproj-toggle-guide-btn"
                onClick={() => setShowGuideEditor((v) => !v)}
              >
                <Edit3 size={12} />
                {showGuideEditor ? "Hide style guide prompt" : "Inspect & tweak style guide"}
                {showGuideEditor ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            </div>

            {/* Presets Grid */}
            <div className="ws-newproj-preset-grid">
              {STYLE_PRESETS.map((p) => {
                const isSelected = !isCustomStyle && selectedPresetId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`ws-newproj-preset-card ${isSelected ? "selected" : ""}`}
                    onClick={() => handleSelectPreset(p)}
                    title={p.label}
                  >
                    <img src={p.image} alt={p.label} className="ws-newproj-preset-img" />
                    <div className="ws-newproj-preset-overlay" />
                    <div className="ws-newproj-preset-info">
                      <span className="ws-newproj-preset-title">{p.label}</span>
                      {isSelected && (
                        <span className="ws-newproj-preset-active-tag">
                          <Check size={10} /> Active
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}

              {/* Custom Style Card */}
              <button
                type="button"
                className={`ws-newproj-preset-card custom-card ${isCustomStyle ? "selected" : ""}`}
                onClick={handleSelectCustom}
                title="Define a unique style prompt"
              >
                <div className="ws-newproj-custom-bg">
                  <Sparkles size={22} className="ws-newproj-custom-sparkle" />
                </div>
                <div className="ws-newproj-preset-overlay" />
                <div className="ws-newproj-preset-info">
                  <span className="ws-newproj-preset-title">Custom Style</span>
                  {isCustomStyle && (
                    <span className="ws-newproj-preset-active-tag">
                      <Check size={10} /> Active
                    </span>
                  )}
                </div>
              </button>
            </div>

            {/* Custom Style Name Input (if custom active) */}
            {isCustomStyle && (
              <div className="ws-newproj-custom-input-row">
                <input
                  className="ws-input"
                  placeholder="Custom Style Name (e.g. Claymation, Oil Painting, Blueprint…)"
                  value={customStyleName}
                  onChange={(e) => setCustomStyleName(e.target.value)}
                  style={{ fontSize: 13 }}
                />
              </div>
            )}

            {/* Selected Style Guide Preview / Editor */}
            <div className="ws-newproj-guide-panel">
              <div className="ws-newproj-guide-header">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="ws-newproj-guide-dot" />
                  <span className="ws-newproj-guide-title">
                    Active Style Guide Prompt (Injected into generations)
                  </span>
                </div>
                {!showGuideEditor && (
                  <button
                    type="button"
                    className="ws-newproj-guide-edit-link"
                    onClick={() => setShowGuideEditor(true)}
                  >
                    <Edit3 size={11} /> Edit Prompt
                  </button>
                )}
              </div>

              {showGuideEditor ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <textarea
                    className="ws-input ws-newproj-guide-textarea ns-scroll"
                    rows={4}
                    value={styleGuide}
                    placeholder="Describe lighting, color palette, medium, texture, and what the AI must avoid..."
                    onChange={(e) => setStyleGuide(e.target.value)}
                  />
                  <div className="ws-newproj-guide-subtext">
                    Specify what to include as well as what it must <i>not</i> look like (e.g., "no 3D shading, no photographic skin").
                  </div>
                </div>
              ) : (
                <div
                  className="ws-newproj-guide-preview"
                  onClick={() => setShowGuideEditor(true)}
                  title="Click to edit prompt"
                >
                  "{styleGuide || "No custom style guide specified."}"
                </div>
              )}
            </div>
          </div>

          {/* 4. Canvas Aspect Ratio */}
          <div className="ws-newproj-section">
            <div className="ws-mlabel" style={{ marginBottom: 9 }}>
              Canvas Aspect Ratio
            </div>
            <div className="ws-newproj-aspect-row">
              {ASPECTS.map((a) => {
                const isSelected = aspect === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`ws-newproj-aspect-btn ${isSelected ? "selected" : ""}`}
                    onClick={() => setAspect(a.id)}
                  >
                    <div className="ws-newproj-aspect-icon-box">
                      <div
                        className="ws-newproj-aspect-shape"
                        style={{ width: a.w, height: a.h }}
                      />
                    </div>
                    <div className="ws-newproj-aspect-label">{a.label}</div>
                    <div className="ws-newproj-aspect-ratio">{a.ratio}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4b. Default models. */}
          <div className="ws-newproj-section">
            <div className="ws-newproj-label-row" style={{ marginBottom: 9 }}>
              <label className="ws-mlabel">
                Default Models <span className="ws-newproj-opt">(optional)</span>
              </label>
              <span className="ws-newproj-hint">
                {imagePick || videoPick || qualityPick
                  ? "pinned to this project"
                  : "your defaults — change them any time in project settings"}
              </span>
            </div>
            <ModelDefaults
              image={imagePick ?? inherited.image_model}
              video={videoPick ?? inherited.video_model}
              quality={qualityPick ?? inherited.image_quality}
              onImage={setImagePick}
              onVideo={setVideoPick}
              onQuality={setQualityPick}
            />
          </div>

          {/* 5. Story Logline & Premise */}
          <div className="ws-newproj-section">
            <div className="ws-newproj-label-row">
              <label className="ws-mlabel" htmlFor="project-logline-input">
                Story Premise / Logline <span className="ws-newproj-opt">(optional)</span>
              </label>
              <span className="ws-newproj-hint">Sets the tone for the AI Director & Storyboard</span>
            </div>
            <textarea
              id="project-logline-input"
              className="ws-input ws-newproj-logline-input"
              rows={2}
              placeholder="e.g. In a neon-lit rainsoaked mega-city, a renegade data courier races against time to deliver the final memory fragment..."
              value={logline}
              onChange={(e) => setLogline(e.target.value)}
            />

            {/* Quick Genre / Tone Tags */}
            <div className="ws-newproj-tags-wrap">
              <span className="ws-newproj-tags-label">Quick Tone / Themes:</span>
              <div className="ws-newproj-tags-list">
                {GENRE_TAGS.map((g) => {
                  const active = selectedGenres.includes(g);
                  return (
                    <button
                      key={g}
                      type="button"
                      className={`ws-newproj-tag-pill ${active ? "active" : ""}`}
                      onClick={() => toggleGenre(g)}
                    >
                      {active && <Check size={10} />}
                      {g}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="ws-modal-foot ws-newproj-foot">
          <div className="ws-newproj-summary">
            <span className="ws-newproj-summary-badge">
              {medium.replace("_", " ")}
            </span>
            <span className="ws-newproj-summary-div">/</span>
            <span className="ws-newproj-summary-style">
              {!isCustomStyle && currentPreset && (
                <img
                  src={currentPreset.image}
                  alt={currentPreset.label}
                  className="ws-newproj-summary-img"
                />
              )}
              {isCustomStyle ? customStyleName || "Custom" : currentPreset?.label || "Anime"}
            </span>
            <span className="ws-newproj-summary-div">/</span>
            <span className="ws-newproj-summary-aspect">{aspect}</span>
            {selectedGenres.length > 0 && (
              <>
                <span className="ws-newproj-summary-div">/</span>
                <span className="ws-newproj-summary-genres">
                  {selectedGenres.slice(0, 2).join(", ")}
                  {selectedGenres.length > 2 ? ` +${selectedGenres.length - 2}` : ""}
                </span>
              </>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              className="ws-ghost"
              onClick={ws.closeModal}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ws-primary ws-newproj-create-btn"
              disabled={!title.trim() || busy}
              onClick={handleCreate}
            >
              {busy ? (
                <>
                  <Loader2 size={14} className="ns-spin" />
                  Creating Project…
                </>
              ) : (
                <>
                  <Check size={15} />
                  Create Project
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
