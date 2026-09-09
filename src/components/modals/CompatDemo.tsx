// The compatibility check, run against the MOCKED machine — a harness screen,
// dev-only, reached at /ui/compat?desktop=…
//
// It exists because the check's answer depends on hardware this Mac does not
// have. "Does a 4090 get a green tick where a 16GB M3 gets a refusal" cannot
// be reviewed by looking at the M3, and the unit tests prove the arithmetic
// without proving that `compatEnv()` reads the machine correctly or that the
// panel renders three verdicts distinguishably. Switching `?desktop=` re-runs
// the real code path against a different machine.
//
// The graphs below are real shapes, not fixtures invented to pass: a Wan 2.2
// i2v graph (two 14GB halves and a text encoder), the SD 1.5 graph this
// engine actually rendered, and one that names a node pack from a repo the
// installer does not clone.
import React, { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import ModalShell from "./ModalShell";
import CompatPanel from "./CompatPanel";
import { analyseGraph, compatEnv, type CompatEnv, type CompatReport } from "../../lib/compat";
import { getObjectInfo } from "../../lib/comfyLocal";
import { detectSlots, type ApiGraph } from "../../lib/workflowAdapter";

const WAN22: ApiGraph = {
  "1": { class_type: "UNETLoader",
         inputs: { unet_name: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors" } },
  "2": { class_type: "UNETLoader",
         inputs: { unet_name: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors" } },
  "3": { class_type: "CLIPLoader",
         inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan" } },
  "4": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "5": { class_type: "EmptyHunyuanLatentVideo",
         inputs: { width: 1280, height: 720, length: 121, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["3", 0] } },
  "7": { class_type: "KSampler", inputs: { seed: 0, steps: 20, model: ["1", 0] } },
  "8": { class_type: "SaveImage", inputs: { images: ["7", 0] } },
};

const SD15: ApiGraph = {
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "v1-5-pruned-emaonly.safetensors" } },
  "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["1", 1] } },
  "4": { class_type: "KSampler", inputs: { seed: 1, steps: 20, model: ["1", 0] } },
  "5": { class_type: "SaveImage", inputs: { images: ["4", 0] } },
};

const EXOTIC: ApiGraph = {
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "v1-5-pruned-emaonly.safetensors" } },
  "2": { class_type: "SeedVR2", inputs: { model: "seedvr2_ema_3b_fp8_e4m3fn.safetensors" } },
  "3": { class_type: "RIFE VFI", inputs: { multiplier: 2 } },
  "4": { class_type: "SomeoneElsesMysteryNode", inputs: {} },
  "5": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
};

const CASES: [string, ApiGraph][] = [
  ["Wan 2.2 i2v 14B — two halves plus an encoder", WAN22],
  ["SD 1.5 — what this engine actually rendered", SD15],
  ["A graph naming packs the installer does not clone", EXOTIC],
];

export default function CompatDemo() {
  const [env, setEnv] = useState<CompatEnv | null>(null);

  useEffect(() => {
    // Ask the engine for its node list when one answers. Without it the node
    // half of every verdict is "not checked" — which is the honest state for a
    // stopped engine and worth being able to see too: run this screen with
    // `&engine=installed` instead of `&engine=running`.
    void getObjectInfo().catch(() => null).then((oi) => compatEnv(oi)).then(setEnv);
  }, []);

  const gpu = env?.hardware?.gpus?.[0];
  const reports: [string, CompatReport][] = env
    ? CASES.map(([label, g]) => [label, analyseGraph(g, env, detectSlots(g))])
    : [];

  return (
    <ModalShell
      icon={<Cpu size={15} />}
      title="Will this run here?"
      context={gpu ? `${gpu.name} · ${(gpu.vram_mb / 1024).toFixed(0)}GB${gpu.unified ? " unified" : ""}`
                   : "no GPU detected"}
      width={720}
      onClose={() => { /* harness: nothing to close to */ }}
    >
      <div className="ws-modal-body ns-scroll"
           style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {!env && <div className="ws-empty">Reading the machine…</div>}
        {reports.map(([label, r]) => (
          <div key={label}>
            <div style={{ fontSize: 11.5, color: "#5e6678", marginBottom: 5 }}>{label}</div>
            <CompatPanel r={r} />
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
