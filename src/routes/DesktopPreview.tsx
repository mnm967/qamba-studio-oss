// A component harness for screens this machine cannot otherwise reach. Dev
// builds only.
//
// WHY IT SITS ABOVE AuthGate. These screens describe the MACHINE — its GPU, its
// engine, its models — and none of them read a project, an episode or anything
// else RLS protects. Putting the harness behind the sign-in gate would mean
// every automated UI run needed a real session, which is both a credential a
// test should not hold and a thing an agent should not click through on
// someone's behalf. Nothing here queries Supabase.
//
// It is the only route outside the gate, and it renders nothing unless the URL
// asked for a mocked bridge (`?desktop=…`), so an unauthenticated visitor to a
// dev server still sees an empty page rather than a tour of the app.
import React from "react";
import { useParams } from "react-router-dom";
import { isDesktop } from "../lib/desktop";
// The modals are styled by the workspace sheet, which is imported by
// Workspace.tsx — and that is not mounted here. Without these the harness
// renders correct markup with no design at all, which is worse than useless
// for reviewing one: it looks broken and the bug is the harness.
import "../styles/workspace.css";

const EngineModal = React.lazy(() => import("../components/modals/EngineModal"));
const FirstRunSetupModal = React.lazy(() => import("../components/modals/FirstRunSetupModal"));
const CivitaiImportModal = React.lazy(() => import("../components/modals/CivitaiImportModal"));
const CompatDemo = React.lazy(() => import("../components/modals/CompatDemo"));
const ReplanDemo = React.lazy(() => import("../components/modals/ReplanDemo"));
const BlockAudioDemo = React.lazy(() => import("../components/modals/BlockAudioDemo"));
const PanelRegenDemo = React.lazy(() => import("../components/modals/PanelRegenDemo"));
const TakeAssemblyDemo = React.lazy(() => import("../components/modals/TakeAssemblyDemo"));
const NewProjectDemo = React.lazy(() => import("../components/modals/NewProjectDemo"));
const CastWorldRefsDemo = React.lazy(() => import("../components/modals/CastWorldRefsDemo"));
const WizardModelsDemo = React.lazy(() => import("../components/modals/WizardModelsDemo"));
const NestedEntryDemo = React.lazy(() => import("../components/modals/NestedEntryDemo"));
const BibleVoiceDemo = React.lazy(() => import("../components/modals/BibleVoiceDemo"));
const QueuePopover = React.lazy(() => import("../components/shell/QueuePopover"));
const WorkflowRepairPanel = React.lazy(() => import("../components/shell/WorkflowRepairPanel"));
const DirectorChromeDemo = React.lazy(() => import("../components/shell/DirectorChromeDemo"));
const JobPromptDemo = React.lazy(() => import("../components/shell/JobPromptDemo"));
const RenderSettingsDemo = React.lazy(() => import("../components/modals/RenderSettingsDemo"));
const WorkflowsBody = React.lazy(() =>
  import("../components/shell/WorkflowsView").then((m) => ({ default: m.WorkflowsBody })));
import { primeCatalog } from "../lib/catalog";
import type { ModelCatalogRow } from "../lib/db/types";

/** The hosted rows the API-keys tab lights up, primed so `/ui/engine` can show
 *  a model list with no session. `model_catalog_visible` answers with nothing
 *  when signed out — a real state, and not the one you want to review a
 *  key-dependent layout in. Same escape hatch, and same reason, as
 *  `/ui/panel`'s. Ids and providers match `gen_model_catalog.py`;
 *  `byokCatalog.test.ts` is what keeps that true. */
const HOSTED_FIXTURE: ModelCatalogRow[] = ([
  ["gpt-image-2", "openai", "GPT Image 2", "image", 0.06],
  ["gpt-image-1.5", "openai", "GPT Image 1.5", "image", 0.07],
  ["nano-banana-2", "google", "Nano Banana 2", "image", 0.067],
  ["nano-banana-2-lite", "google", "Nano Banana 2 Lite", "image", 0.0336],
  ["nano-banana-pro", "google", "Nano Banana Pro", "image", 0.134],
  ["fal-h3-2k", "fal", "MiniMax H3 via fal · 2K", "video", 0.26],
  ["seedream-5-pro", "fal", "Seedream 5.0 Pro", "image", 0.075],
] as const).map(([id, provider, display_name, kind, usd]) => ({
  id, family: "demo", display_name, kind: kind as "image" | "video", provider,
  modes: kind === "video" ? ["t2v", "i2v"] : ["t2i", "edit"],
  sizes: null, max_seconds: kind === "video" ? 15 : null,
  fps: kind === "video" ? 24 : null,
  frame_base: null, frame_rem: null, dim_step: null,
  pricing: { unit: kind === "video" ? "second" : "image", usd },
  capabilities: {}, enabled: false, sort: 1,
}));
primeCatalog(HOSTED_FIXTURE);

/** Render functions rather than component references: the three screens do not
 *  share a prop shape, and casting them to one is how a harness starts lying
 *  about what it is testing. */
const SCREENS: Record<string, () => React.ReactElement> = {
  engine: () => <EngineModal />,
  firstrun: () => <FirstRunSetupModal />,
  civitai: () => <CivitaiImportModal projectId={null} />,
  // The compatibility check reads the MACHINE, so its answer cannot be
  // reviewed on the one machine this repo is developed on. Switching
  // `?desktop=` runs the same code against a 4090 or a headless box.
  compat: () => <CompatDemo />,
  // The queue popover is normally deep inside the authed workspace, but the
  // DOWNLOAD half of it is desktop state and needs no session at all — the
  // jobs half just comes back empty. Worth reaching directly: a download
  // showing up here is the whole point of putting it here.
  queue: () => <QueuePopover />,
  // Not a desktop screen. It is here for the OTHER reason this harness
  // exists — the real one is behind a sign-in, a project, an interview and a
  // several-minute plan, and the bug it is guarding against (a modal opened
  // from inside a `backdrop-filter`ed modal resolving its scrim against the
  // wrong box) is only ever visible in a picture. It reads no Supabase, same
  // as everything else here.
  replan: () => <ReplanDemo />,
  // The "change the audio" modal, against fixtures. Here for the reason
  // `panel` is, plus one of its own: its two riskiest claims are pictures — a
  // take tile has to be sized to the RENDER (a 9:16 take cropped to a square
  // still looks like a shot), and the negative field has to be ABSENT rather
  // than disabled where a row's cfg cannot evaluate one. `?fixture=empty` is
  // the block that has never rendered. It cannot queue: a review screen must
  // not be able to spend GPU time by being opened.
  blockaudio: () => <BlockAudioDemo />,
  // Also not a desktop screen, and here for the same reason as `replan` plus
  // one of its own: this modal is two intents in one layout, and "the position,
  // size and order of every element are identical between them" is a claim only
  // a picture can check. It DOES read Supabase — the beat behind the alternates
  // rail — which simply comes back empty without a session, exactly as the
  // queue popover's jobs half does.
  panel: () => <PanelRegenDemo />,
  // The repair panel, on a workflow broken the way a real import is. Here for
  // the reason `compat` is: its whole job is to distinguish the engine's own
  // answer from a model's opinion, and "do the exact ones and the guesses read
  // differently" is a claim only a picture can check. It diagnoses against
  // whatever ComfyUI is on this machine, so it also exercises the no-engine
  // path when none is running.
  repair: () => <RepairDemo />,
  // The workflow inspector, admin gate bypassed. It is here because its
  // failure mode was invisible in code and obvious in a picture: the page
  // hardcoded `tier = "aws"`, so on the desktop app it described the render
  // pod — the header read "tier aws · ComfyUI · pod stopped" while a local
  // engine was rendering blocks from a different map. What a review has to
  // see is that the header NAMES the machine and that switching tiers changes
  // which templates are in use. Reads Supabase for imported graphs, which
  // comes back empty without a session, exactly as the queue popover does.
  workflows: () => <WorkflowsBody />,
  // The director panel's chrome, at its design width. Not a desktop screen —
  // here for the same reason `replan` and `panel` are, plus one of its own:
  // the handoff it implements calls its colours, type sizes, spacing, radii
  // and icon sizes FINAL, and every one of those is a claim only a picture can
  // check. It reads no Supabase at all, so it needs no session and no project.
  director: () => <DirectorChromeDemo />,
  // The queued-row prompt panel. Here for the reason `panel` is, plus one of
  // its own: the claim is that a row whose prompt can be changed and a row
  // whose prompt does not exist yet are told apart BEFORE either is opened,
  // and "the two icons read differently" is only checkable in a picture. The
  // real one needs a session and work actually queued, which is a state that
  // is gone again in minutes.
  jobprompt: () => <JobPromptDemo />,
  // The render settings modal. Here for the reason `panel` is, plus one of its
  // own: this screen's controls CHANGE SHAPE with the format — a CRF slider
  // becomes a named-profile row for ProRes, the audio codecs are rebuilt from
  // the container's own legality, and the Hardware switch disappears where
  // there is no NVENC path. "The right control is showing, and the wrong one
  // is ABSENT rather than disabled" is a claim only a picture can check, and
  // the real one is behind a session, a project and a timeline with clips.
  render: () => <RenderSettingsDemo />,
  // The assembly viewer, for the one reason a picture is the only evidence:
  // both of its failure modes — a cell that is the wrong SHAPE and a cell
  // showing the wrong MOMENT — look exactly like a correct build in prose and
  // in any assertion about state. The clips are synthesised in the browser, so
  // this reads nothing and fetches nothing.
  takes: () => <TakeAssemblyDemo />,
  // The create-project form, for its newest section alone. Here for the reason
  // `panel` is — the real one is behind a sign-in — plus one of its own: two
  // model pickers in one row and the local-storage warning under them are
  // claims only a picture can check, and the pairing that warning is about (a
  // project on this computer, defaulted to a model on the studio's pod) is
  // what you get by touching nothing at all. It primes its own catalog, which
  // is safe because every screen here is lazy: the fixture above stands until
  // this module is the one that loads.
  newproject: () => <NewProjectDemo />,
  // The wizard's sheets bar, in all of its states at once. Here for the reason
  // `replan` is — the real one is behind a sign-in, a project, an interview and
  // a several-minute plan — plus one of its own: its states are MINUTES apart
  // on the real screen (you cannot see "nothing missing" and "twelve missing"
  // together, and "drawing" lasts only as long as a render), and the case it
  // exists for is a dozen long names inside a fixed width. It queues nothing.
  castworld: () => <CastWorldRefsDemo />,
  // The wizard's step-4 pickers, on seven machines at once. Here for the
  // reason `castworld` is — the real screen is behind a sign-in, a project, an
  // interview and a several-minute plan — plus one of its own: what it shows
  // depends on a MACHINE this repo is not (a member's laptop with half the
  // weights down, a project living on the disk it runs on), and "these read as
  // two places at a glance" is a claim only a picture can check. It queues
  // nothing and reads nothing.
  wizmodels: () => <WizardModelsDemo />,
  // The "new bible entry" modal as the wizard opens it — nested, portalled and
  // lifted. Here because "it opens OVER the wizard rather than behind or inside
  // it" is a claim no assertion about state can make, and this repo has shipped
  // the inverse before. See the file's own header.
  nestedentry: () => <NestedEntryDemo />,
  // The bible sheet's voice row, in every casting state at once. Here because
  // "each entry opens on the engine IT was cast on" is a claim only a picture
  // can check — and the reading it depends on walked one engine, so a
  // character cast on the second read as uncast and was offered a re-record of
  // a voice that already existed. It queues nothing: see the file's header.
  biblevoice: () => <BibleVoiceDemo />,
};

/** A workflow broken three ways at once: a checkpoint that is not installed, a
 *  preview-only output, and a node class from a pack nobody has. Each takes a
 *  different route through the fixer — an exact swap, an exact reclass, and an
 *  advice-only entry that is the ONLY one a model is asked about. */
function RepairDemo() {
  const wf = {
    id: "00000000-0000-4000-8000-000000000000",
    owner_id: null, project_id: null,
    name: "Civitai import (demo)", base_model: "wan2.2",
    source: "civitai" as const, source_url: null,
    civitai_model_id: null, civitai_version_id: null, ui_graph: null,
    api_graph: {
      "1": { class_type: "UnetLoaderGGUF",
             inputs: { unet_name: "Wan2.2-TI2V-5B-Q8_0.safetensors" } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: "a lone red buoy at dawn", clip: ["2", 0] } },
      "7": { class_type: "SomeCivitaiCustomNode", inputs: { images: ["6", 0] } },
      "9": { class_type: "PreviewImage", inputs: { images: ["7", 0] } },
    },
    slots: {},
    requirements: {}, status: "error" as const,
    last_error: { message: "ComfyUI rejected graph: " + JSON.stringify({
      error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
      node_errors: { "1": { class_type: "UnetLoaderGGUF", errors: [{
        type: "value_not_in_list", message: "Value not in list",
        details: "unet_name: 'Wan2.2-TI2V-5B-Q8_0.safetensors' not in [...]",
        extra_info: { input_name: "unet_name", received_value: "Wan2.2-TI2V-5B-Q8_0.safetensors",
                      input_config: [["Wan2.2-TI2V-5B-Q6_K.gguf", "Wan2.2-TI2V-5B-Q8_0.gguf"], {}] } }] } },
    }) },
    last_tested_at: null, created_at: "", updated_at: "",
  };
  const [row, setRow] = React.useState(wf);
  return (
    <div style={{ maxWidth: 720 }}>
      <WorkflowRepairPanel w={row as never} onChange={setRow as never} />
    </div>
  );
}

export default function DesktopPreview() {
  const { screen = "engine" } = useParams();
  const render = SCREENS[screen];
  // Remount the screen WITHOUT reloading the page — `qamba:test-remount` is
  // what "close the modal and reopen it" actually is. A `page.goto` would
  // reload, which also resets the mocked bridge's own state (its in-flight
  // download registry included) and so cannot reproduce the case that matters:
  // the modal unmounting while the download it started keeps running.
  const [remounts, setRemounts] = React.useState(0);
  React.useEffect(() => {
    const h = () => setRemounts((n) => n + 1);
    window.addEventListener("qamba:test-remount", h);
    return () => window.removeEventListener("qamba:test-remount", h);
  }, []);

  if (!isDesktop()) {
    return (
      <div style={{ padding: 28, color: "#c7cddb", font: "13px ui-monospace, Menlo, monospace" }}>
        This harness needs the mocked desktop bridge. Add <b>?desktop=m3air</b> to the URL
        (machines: m3air, m3max, rtx4090, rtx4070ti, headless; add
        <b> &amp;engine=installed</b> or <b>&amp;engine=running</b>).
      </div>
    );
  }
  if (!render) {
    return (
      <div style={{ padding: 28, color: "#c7cddb", font: "13px ui-monospace, Menlo, monospace" }}>
        Unknown screen. Try {Object.keys(SCREENS).map((s) => `/ui/${s}`).join(", ")}.
      </div>
    );
  }
  // `key` is what makes this a real unmount rather than a re-render: the
  // screen's state, effects and event subscriptions all go and come back.
  return <React.Suspense fallback={null}><div key={remounts}>{render()}</div></React.Suspense>;
}
