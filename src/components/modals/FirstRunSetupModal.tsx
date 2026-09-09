// First run on the desktop build: what this machine is, what it can render,
// and where the engine lives.
//
// THE HONEST VERSION OF A SETUP WIZARD. The temptation is to promise the
// flagship model to everyone and let the OOM explain later. This screen does
// the opposite — it reads the hardware first and then says what will actually
// work, including "not this, use cloud mode" when that is the answer. A 16GB
// laptop is not a small render pod; it is a machine that should be drawing
// storyboard panels while the pod renders video, and saying so on the first
// screen is worth more than a download button.
//
// IT ENDS BY HANDING OFF, NOT BY FINISHING. Choosing "install a private
// engine" opens the engine screen, which owns the installer AND the model
// list. Repeating either here would be two places to keep in step with
// engine.rs, and would ask the same question twice — the wizard's job is to
// establish what this machine is and how it should render, which is two
// steps, not three.
import React, { useEffect, useState } from "react";
import {
  AlertTriangle, Check, Cloud, Cpu, HardDrive, Loader2, Plug, Rocket, Server, Sparkles,
} from "lucide-react";
import ModalShell from "./ModalShell";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import {
  detectHardware, isDesktop, machineBudgetGb, machineRamGb,
  type HardwareProfile,
} from "../../lib/desktop";
import {
  FAMILIES, bestFor, fits, fmtSize, mirrorIndex, variantMb,
  type ModelFamily, type ModelVariant,
} from "../../lib/engineCatalog";
import { DEFAULT_COMFY, pingComfy, type ComfyStatus } from "../../lib/comfyLocal";

const INK_MUTE = "#5e6678";
const C_OK = "#6fd08c";
const C_RISK = "#e8a13a";

const SETUP_KEY = "qamba.desktop.setup";

export interface DesktopSetup {
  /** "install" hands off to the engine screen on Finish; "local" links an
   *  engine the user already runs; "cloud" is the pod, as the web app does. */
  engine: "install" | "local" | "cloud" | null;
  comfyUrl: string;
  preset: string | null;
  completedAt: string;
}

export const loadSetup = (): DesktopSetup | null => {
  try { return JSON.parse(localStorage.getItem(SETUP_KEY) ?? "null"); } catch { return null; }
};
export const saveSetup = (s: DesktopSetup) => localStorage.setItem(SETUP_KEY, JSON.stringify(s));
/** Forget that setup ever ran, so the wizard opens again. */
export const clearSetup = () => localStorage.removeItem(SETUP_KEY);

/** Show the wizard on the desktop build until it has been completed once. */
export const needsFirstRun = (): boolean => isDesktop() && loadSetup() === null;

const gb = (mb: number) => (mb / 1024).toFixed(mb < 10240 ? 1 : 0);

/**
 * The studio's own video model, refused on MEMORY rather than on the card.
 *
 * This is the least obvious result of the H3 tier benchmark and the one most
 * worth putting on the first screen: a 12GB card clears every H3 rung on VRAM,
 * and the leanest of them still wants ~23GB of system RAM because ComfyUI
 * answers a small card by streaming weights out of host memory. Such a machine
 * silently gets offered Wan instead — a worse model, for a reason that is
 * nowhere on screen, next to a page of graphics-card figures. Someone reading
 * that goes and buys a bigger GPU, which would not help.
 *
 * It asks about the STUDIO DEFAULT specifically rather than "any video model",
 * because Wan carries no measured `ram_gb` and therefore always fills the
 * video slot — making the general question always answer "no". Unset means
 * unmeasured, and unmeasured must never become a refusal.
 */
function studioVideoRamGap(budgetGb: number, ramGb: number): number | null {
  const fam = FAMILIES.find((f) => f.media === "video" && f.studioDefaultFor);
  if (!fam) return null;
  const onCard = fam.variants.filter((v) => fits(v, budgetGb));
  if (!onCard.length || onCard.some((v) => fits(v, budgetGb, ramGb))) return null;
  const needs = onCard.filter((v) => v.ram_gb != null).map((v) => v.ram_gb as number);
  return needs.length ? Math.min(...needs) : null;
}

function Row({ icon, label, value, note }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; note?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "5px 0" }}>
      <span style={{ color: INK_MUTE, flex: "none", marginTop: 1 }}>{icon}</span>
      <span style={{ fontSize: 12, color: INK_MUTE, width: 96, flex: "none" }}>{label}</span>
      <span style={{ minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 12 }}>{value}</span>
        {note && <span style={{ fontSize: 11.5, color: INK_MUTE }}> — {note}</span>}
      </span>
    </div>
  );
}

export default function FirstRunSetupModal() {
  const ws = useWorkspaceStore();
  const [step, setStep] = useState(0);
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [probing, setProbing] = useState(true);
  /** What the INSTALLER can actually give this machine. Quoting anything else
   *  here is how step 1 promised "Wan 2.2 5B" while the next screen offered
   *  SD 1.5 — two lists, one of them aspirational, and no way for a user to
   *  tell which number to believe. */
  type Pick = { family: ModelFamily; variant: ModelVariant } | null;
  const [best, setBest] = useState<{ image: Pick; video: Pick }>({ image: null, video: null });
  const [engine, setEngine] = useState<"install" | "local" | "cloud" | null>(null);
  const [comfyUrl, setComfyUrl] = useState(DEFAULT_COMFY);
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const p = await detectHardware();
      if (!live) return;
      setHw(p);
      const budget = machineBudgetGb(p);
      // BOTH BUDGETS, and the second one is the H3 tier benchmark's doing: the
      // rungs that fit the smallest cards stream their weights out of host
      // memory and want 23-48GB of it. Asking about VRAM alone is how a machine
      // with a good card and 16GB of RAM gets promised a render that gets
      // oom-killed 110 seconds in — measured, in a capped cgroup.
      const ram = machineRamGb(p);
      // THE MIRROR HAS TO BE IN HAND BEFORE ANYTHING IS RECOMMENDED, and it was
      // not — this passed `null` and never fetched the index at all.
      //
      // `bestFor` refuses a family whose weights nothing can fetch, and for a
      // GATED file "nothing can fetch it" is exactly what a null mirror means.
      // So every family the studio mirrors — all of LTX 2.5, DaSiWa — was
      // invisible on the one screen that decides what a new install downloads,
      // while the engine window two clicks away offered the same models
      // happily. A model that is one HTTP request from being installable and is
      // never mentioned is worse than one that is honestly out of reach.
      //
      // It is awaited rather than raced with a default: recommending "nothing
      // fits" and then quietly changing the answer once the index lands is how
      // someone ends up in cloud mode on a machine that could have rendered.
      // `mirrorIndex` times out on its own, so the wait is bounded.
      const mirror = await mirrorIndex();
      if (!live) return;
      const b = {
        image: bestFor("image", budget, mirror, ram),
        video: bestFor("video", budget, mirror, ram),
      };
      setBest(b);
      setPreset(b.image?.variant.id ?? null);
      // Default to the path that ends in a render. Someone whose machine can run
      // nothing locally is better served by cloud mode, and pre-selecting an
      // install for them would be the wizard recommending something it just
      // said would not work.
      setEngine(b.image || b.video ? "install" : "cloud");
      setProbing(false);
      // If an engine is already listening, the "link it" path is the obvious
      // default and the user should not have to discover that themselves.
      const s = await pingComfy();
      if (live && s.reachable) { setStatus(s); setEngine("local"); }
    })();
    return () => { live = false; };
  }, []);

  const test = async () => {
    setTesting(true);
    setStatus(await pingComfy(comfyUrl));
    setTesting(false);
  };

  const finish = () => {
    saveSetup({
      engine, comfyUrl, preset: preset ?? null, completedAt: new Date().toISOString(),
    });
    // One screen owns installing. Duplicating the installer here would mean two
    // places to keep in step with engine.rs, and the engine screen is also
    // where models and add-ons live — which is the next thing anyone wants.
    if (engine === "install") ws.openModal({ kind: "engine" });
    else ws.closeModal();
  };

  const gpu = hw?.gpus[0];
  const budgetGb = machineBudgetGb(hw);
  const ramGb = machineRamGb(hw);
  /** H3 clears this card and is refused by this machine's memory — the case
   *  worth naming, because the fix is RAM and every other number on screen is
   *  about the graphics card. */
  const h3RamGap = hw ? studioVideoRamGap(budgetGb, ramGb) : null;

  return (
    <ModalShell
      icon={<Sparkles size={15} />}
      title="Welcome to Qamba Studio"
      context={["Your machine", "How to render"][step]}
      width={720}
      onClose={ws.closeModal}
      footer={
        <>
          <span className="mono" style={{ fontSize: 11, color: INK_MUTE }}>
            step {step + 1} of 2
          </span>
          <div style={{ flex: 1 }} />
          {step > 0 && (
            <button className="ws-actbtn" onClick={() => setStep((s) => s - 1)}>Back</button>
          )}
          {step < 1 ? (
            <button className="ws-primary" disabled={probing} onClick={() => setStep((s) => s + 1)}>
              Continue
            </button>
          ) : (
            <button className="ws-primary" disabled={!engine} onClick={finish}>
              <Rocket size={13} />
              {engine === "install" ? "Install the engine" : "Finish setup"}
            </button>
          )}
        </>
      }
    >
      <div className="ws-modal-body ns-scroll" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {step === 0 && (
          <>
            <div className="ws-card">
              <span className="ws-mlabel">THIS MACHINE</span>
              {probing ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: INK_MUTE }}>
                  <Loader2 size={13} className="ws-spin" /> Reading the hardware…
                </div>
              ) : hw ? (
                <>
                  <Row icon={<Cpu size={13} />} label="Processor" value={hw.cpu || hw.arch}
                       note={`${hw.cores} cores`} />
                  <Row icon={<Server size={13} />} label="Graphics"
                       value={gpu ? gpu.name : "none detected"}
                       note={gpu
                         ? gpu.unified
                           ? `${gb(gpu.vram_mb)}GB unified memory, shared with the system`
                           : `${gb(gpu.vram_mb)}GB dedicated VRAM`
                         : "video rendering will have to be done in cloud mode"} />
                  {/* RAM IS A RENDER BUDGET HERE, not a spec-sheet line. A
                      small graphics card is answered by streaming weights out
                      of host memory, so the models that fit the smallest cards
                      are the ones that want the most of this — and a machine
                      can pass every VRAM check on the next screen and still be
                      unable to run one of them. */}
                  <Row icon={<HardDrive size={13} />} label="Memory" value={`${gb(hw.ram_mb)}GB RAM`}
                       note={hw.ram_mb < 32_768
                         ? "video models stream weights through this — under 32GB rules most of them out"
                         : "enough to stream a video model's weights"} />
                  <Row icon={<HardDrive size={13} />} label="Free disk" value={`${gb(hw.free_disk_mb)}GB`}
                       note={hw.free_disk_mb < 30_000 ? "tight for local weights" : undefined} />
                  <Row icon={<Plug size={13} />} label="ComfyUI"
                       value={hw.comfy_paths.length ? `${hw.comfy_paths.length} install found` : "none found"}
                       note={hw.comfy_paths[0]} />
                </>
              ) : (
                <div style={{ fontSize: 12, color: INK_MUTE }}>
                  Hardware detection is only available in the desktop app.
                </div>
              )}
            </div>

            <div className="ws-card" style={{
              border: `1px solid ${best.image || best.video
                ? "rgba(111,208,140,0.28)" : "rgba(232,161,58,0.3)"}`,
            }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                {best.image || best.video
                  ? <Check size={14} style={{ color: C_OK, flex: "none", marginTop: 2 }} />
                  : <AlertTriangle size={14} style={{ color: C_RISK, flex: "none", marginTop: 2 }} />}
                <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                  {gpu?.unified && (
                    <p style={{ margin: "0 0 6px" }}>
                      {gpu.name} shares {gb(gpu.vram_mb)}GB with the system, so about{" "}
                      {((gpu.vram_mb / 1024) * 0.6).toFixed(0)}GB is realistically available
                      to a render.
                    </p>
                  )}
                  {best.image ? (
                    <p style={{ margin: 0 }}>
                      Best <b>image</b> model it can run: <b>{best.image.family.name}</b>{" "}
                      <span className="mono" style={{ fontSize: 11, color: INK_MUTE }}>
                        {best.image.variant.label} · {fmtSize(variantMb(best.image.family, best.image.variant))}
                      </span>
                    </p>
                  ) : (
                    <p style={{ margin: 0 }}>No image model here will run locally.</p>
                  )}
                  {best.video ? (
                    <>
                      <p style={{ margin: "4px 0 0" }}>
                        Best <b>video</b> model it can run: <b>{best.video.family.name}</b>{" "}
                        <span className="mono" style={{ fontSize: 11, color: INK_MUTE }}>
                          {best.video.variant.label} · {fmtSize(variantMb(best.video.family, best.video.variant))}
                        </span>
                      </p>
                      {/* THE FLOOR IS A MEASUREMENT, and saying so is the point.
                          These two figures come from rendering the same clip on
                          capped hardware, not from a model card — which is why
                          the RAM one is here at all. */}
                      {best.video.variant.ram_gb != null && (
                        <p style={{ margin: "3px 0 0", fontSize: 11.5, color: INK_MUTE }}>
                          Measured on capped hardware at{" "}
                          <b>{best.video.variant.vram_gb}GB of VRAM</b> and{" "}
                          <b>{best.video.variant.ram_gb}GB of system RAM</b> for a 3-second
                          clip. Expect minutes, not seconds — these are floors, not speeds.
                        </p>
                      )}
                    </>
                  ) : (
                    <p style={{ margin: "4px 0 0", color: C_RISK }}>
                      No video model here fits this machine — video belongs in Cloud mode.
                      You can still install an engine for stills.
                    </p>
                  )}
                  {/* THE CASE THAT NEEDS NAMING, and it is shown even when a
                      video model WAS found: this machine got the second choice,
                      and the reason is nowhere else on a screen made of
                      graphics-card figures. */}
                  {h3RamGap != null && hw && (
                    <p style={{ margin: "5px 0 0", color: C_RISK, fontSize: 11.5 }}>
                      This card could run <b>MiniMax H3</b> — the model the studio&rsquo;s own
                      episodes are rendered with — but <b>{gb(hw.ram_mb)}GB of RAM cannot</b>.
                      It streams its weights through system memory and the leanest build
                      needs about <b>{h3RamGap}GB</b>. More RAM would unlock it; a bigger
                      GPU would not.
                    </p>
                  )}
                  <p style={{ margin: "6px 0 0", color: INK_MUTE, fontSize: 11.5 }}>
                    Everything else is listed on the next screen with what it needs.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            {/* The recommended path leads, because for anyone without a ComfyUI
                already running it is the only one that ends in a render. */}
            <button className="ws-card" onClick={() => setEngine("install")}
                    style={{ textAlign: "left", width: "100%",
                             border: `1px solid ${engine === "install" ? "rgba(90,162,255,0.5)" : "rgba(255,255,255,0.07)"}` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <Rocket size={14} style={{ color: engine === "install" ? "#5aa2ff" : INK_MUTE }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>Install a private engine</span>
                <span className="mono" style={{
                  fontSize: 10, padding: "2px 6px", borderRadius: 999, color: C_OK,
                  background: "rgba(111,208,140,0.12)", border: "1px solid rgba(111,208,140,0.35)",
                }}>recommended</span>
              </div>
              <p style={{ fontSize: 12, color: INK_MUTE, margin: 0 }}>
                A self-contained ComfyUI with its own Python, packages and models folder.
                No terminal, and nothing on your system is modified. About 2GB, then you
                pick a model.
              </p>
            </button>

            <button className="ws-card" onClick={() => setEngine("local")}
                    style={{ textAlign: "left", width: "100%",
                             border: `1px solid ${engine === "local" ? "rgba(90,162,255,0.5)" : "rgba(255,255,255,0.07)"}` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <Plug size={14} style={{ color: engine === "local" ? "#5aa2ff" : INK_MUTE }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>Use a ComfyUI on this machine</span>
                {status?.reachable && <span className="mono" style={{ fontSize: 10.5, color: C_OK }}>· detected</span>}
              </div>
              <p style={{ fontSize: 12, color: INK_MUTE, margin: 0 }}>
                Renders run on your own GPU, for free, and imported workflows are checked
                against the nodes you actually have installed.
              </p>
            </button>

            {engine === "local" && (
              <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="ws-mlabel">ENGINE ADDRESS</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <input className="ws-input mono" style={{ flex: 1, fontSize: 11.5 }}
                         value={comfyUrl} onChange={(e) => setComfyUrl(e.target.value)} />
                  <button className="ws-actbtn" onClick={() => void test()} disabled={testing}>
                    {testing ? <Loader2 size={12} className="ws-spin" /> : <Plug size={12} />} Test
                  </button>
                </div>
                {status && (
                  status.reachable ? (
                    <div style={{ fontSize: 12, color: C_OK, display: "flex", gap: 6, alignItems: "center" }}>
                      <Check size={12} />
                      Connected{status.version ? ` — ComfyUI ${status.version}` : ""}
                      {status.device ? ` on ${status.device}` : ""}
                      {status.vram_total_mb ? ` (${gb(status.vram_total_mb)}GB)` : ""}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: C_RISK }}>
                      Nothing answered at that address. Start ComfyUI and press Test again —
                      it takes a minute or two to begin listening.
                    </div>
                  )
                )}
                {!!hw?.comfy_paths.length && (
                  <div>
                    <span className="ws-mlabel">FOUND ON DISK</span>
                    {hw.comfy_paths.map((p) => (
                      <div key={p} className="mono" style={{ fontSize: 11, color: INK_MUTE, padding: "2px 0" }}>
                        {p}
                      </div>
                    ))}
                    <p style={{ fontSize: 11.5, color: INK_MUTE, margin: "4px 0 0" }}>
                      Start ComfyUI the way you normally do, then press Test.
                    </p>
                  </div>
                )}
              </div>
            )}

            <button className="ws-card" onClick={() => setEngine("cloud")}
                    style={{ textAlign: "left", width: "100%",
                             border: `1px solid ${engine === "cloud" ? "rgba(90,162,255,0.5)" : "rgba(255,255,255,0.07)"}` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <Cloud size={14} style={{ color: engine === "cloud" ? "#5aa2ff" : INK_MUTE }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>Cloud mode — the studio cloud</span>
              </div>
              <p style={{ fontSize: 12, color: INK_MUTE, margin: 0 }}>
                Everything queues as a job on the shared GPU, exactly as the web app does.
                Nothing to install.
              </p>
            </button>

          </>
        )}

      </div>
    </ModalShell>
  );
}
