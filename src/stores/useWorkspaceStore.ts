// Workspace-shell UI state (design handoff): panel/dock/grid/snap chrome,
// selected rail panel, modal routing. Chrome state persists to localStorage;
// all data state stays in the existing stores + useLiveQuery.
import { create } from "zustand";
import type { GenPreset } from "../lib/genRecipe";
import type { WsView } from "../components/shell/TopBar";

const LS_KEY = "qamba.ws";

export type PanelKind = "shots" | "refs" | "audio" | "queue" | "models" | "library";
export type Tool = "select" | "blade" | "ripple";

interface Persisted {
  panelOpen: boolean;
  panel: PanelKind;
  chatOpen: boolean;
  inspOpen: boolean;
  /** the takes strip under the stage. Both this and `inspOpen` are only ever
   *  consulted WHEN A CLIP IS SELECTED — with no selection both panels are
   *  hidden outright rather than rendering a placeholder, so opening a project
   *  gives the player the whole column. */
  takesOpen: boolean;
  snap: boolean;
  autoAlign: boolean;
  divisor: number;   // grid divisor (1/N of 10s)
  /** keep the preview playing in a corner window when you leave the timeline */
  pipOn: boolean;
  pipSize: number;   // index into the dock's size steps
  pipX: number | null;
  pipY: number | null;
}

const DEFAULTS: Persisted = {
  panelOpen: true, panel: "shots", chatOpen: true, inspOpen: true, takesOpen: true,
  snap: true, autoAlign: true, divisor: 4,
  pipOn: true, pipSize: 0, pipX: null, pipY: null,
};

function loadPersisted(): Persisted {
  try {
    const loaded = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Partial<Persisted>;
    const autoAlign = loaded.autoAlign ?? loaded.snap ?? DEFAULTS.autoAlign;
    const panel = loaded.panel && ["shots", "refs", "audio", "queue", "models", "library"].includes(loaded.panel)
      ? loaded.panel : DEFAULTS.panel;
    return { ...DEFAULTS, ...loaded, autoAlign, snap: autoAlign, panel };
  } catch {
    return DEFAULTS;
  }
}

export type Modal =
  | null
  | { kind: "newProject" }
  | { kind: "scene"; sceneId: string }
  // `fromBeat` is what makes "redraw this panel" possible: the opener knows
  // which shot the image belongs to, and inferring it from the asset only
  // works for panels the pipeline wrote a `target` onto.
  | { kind: "asset"; assetId: string; fromScene?: string; fromBeat?: string }
  | { kind: "newEntry"; entryKind?: string }
  | { kind: "entry"; entryId: string }
  // Lore documents are the retrieval half of the bible: too long to be a card,
  // chunked into rag_chunks and read back a passage at a time.
  | { kind: "loreImport"; projectId: string }
  | { kind: "loreDoc"; docId: string; projectId: string }
  | { kind: "projectSettings"; projectId: string }
  | { kind: "deleteProject"; projectId: string; title: string }
  | { kind: "deleteEntry"; entryId: string; name: string; kindName?: string }
  // fromScene: opened from the scene editor, so closing returns there
  | { kind: "prompt"; blockId: string; fromScene?: string }
  | { kind: "takes"; blockId: string; fromScene?: string }
  | { kind: "pickTake"; blockId: string; clipId?: string; fromScene?: string }
  // Re-score a block: MMAudio watches one of its takes and writes a new
  // soundtrack, published as another take. `clipId` is provenance only — the
  // take is the block's, and the lane repoints through the usual activation.
  | { kind: "blockAudio"; blockId: string; clipId?: string }
  | { kind: "wizard"; projectId?: string }
  // The Civitai hub. `projectId` scopes what an import is filed under; without
  // one the workflow lands on the account-wide shelf, which is deliberate —
  // the hub is reachable from the studio-wide Workflows tab, where no project
  // is open.
  | { kind: "civitai"; projectId?: string | null }
  // Desktop only, once, on first launch.
  | { kind: "firstRun" }
  // The local engine: install, start/stop, models and add-ons.
  // `tab` lets a caller land on the screen that answers its own
  // refusal — "add your openai key" opens the keys tab, not the
  // engine installer.
  | { kind: "engine"; tab?: "engine" | "models" | "llm" | "speech" | "keys" };

interface WorkspaceState extends Persisted {
  queueOpen: boolean;
  tool: Tool;
  modal: Modal;
  /** Which view is on screen. It was a router prop and nothing else could read
   *  it, so anything that needed to describe "where the user is" — the
   *  director's situational context, most of all — had to guess. Set from an
   *  effect in Workspace; deliberately NOT persisted (the route decides on
   *  load, not localStorage). */
  view: WsView | null;
  /** Storyboard view position: the scene on screen and the beat being edited.
   *  Same reason as `view` — the storyboard owns the state, the director needs
   *  to know it, and neither should have to import the other. Both are cleared
   *  when the storyboard unmounts, or the context would keep naming a scene
   *  the user left three views ago. */
  openSceneId: string | null;
  editingBeatId: string | null;
  /** prefill for the director dock composer ("ask the director to rewrite…") */
  dockDraft: string | null;
  /** raise the dock over a modal scrim so the handed-off draft is reachable */
  dockLifted: boolean;
  /** a generation recipe handed from a library card to the generate dock */
  genPreset: GenPreset | null;
  /** asset ids queued for the generate dock from the Refs & cast panel — the
   *  dock is mounted by the library view, so a face picked on the timeline is
   *  held here until the composer mounts and attaches it (one-shot, like
   *  genPreset — leaving it set would re-attach on every re-render). */
  refShelf: string[];
  /** asset ids queued for the DIRECTOR composer — the same handoff `refShelf`
   *  does for the generate dock, so "ask the director about this" can carry the
   *  picture as well as the sentence. No pending-hold dance is needed here
   *  (see GenComposer.applyShelf): the dock is always mounted, so it consumes
   *  the ids on the next render. */
  chatShelf: string[];
  set<K extends keyof WorkspaceState>(k: K, v: WorkspaceState[K]): void;
  toggle(k: "panelOpen" | "chatOpen" | "inspOpen" | "takesOpen" | "snap" | "autoAlign" | "queueOpen" | "pipOn"): void;
  openModal(m: Modal): void;
  closeModal(): void;
  askDirector(draft: string): void;
  reuseGeneration(p: GenPreset): void;
  clearGenPreset(): void;
  shelfRef(id: string): void;
  clearShelf(): void;
  /** Attach an asset to the director composer, and open the dock so the chip
   *  is visible — a silent attachment reads as the button doing nothing, the
   *  same failure `askDirector`'s `dockLifted` exists to prevent. */
  shelfChat(id: string): void;
  clearChatShelf(): void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  ...loadPersisted(),
  queueOpen: false,
  tool: "select",
  modal: null,
  view: null,
  openSceneId: null,
  editingBeatId: null,
  dockDraft: null,
  dockLifted: false,
  genPreset: null,
  refShelf: [],
  chatShelf: [],

  set(k, v) {
    set({ [k]: v } as Partial<WorkspaceState>);
    if (k === "autoAlign" || k === "snap") {
      set({ autoAlign: Boolean(v), snap: Boolean(v) } as Partial<WorkspaceState>);
    }
    persist(get());
  },
  toggle(k) {
    if (k === "snap" || k === "autoAlign") {
      set((s) => ({ snap: !s.autoAlign, autoAlign: !s.autoAlign }));
    } else {
      set((s) => ({ [k]: !s[k] } as Partial<WorkspaceState>));
    }
    persist(get());
  },
  openModal(m) { set({ modal: m }); },
  closeModal() {
    // A modal opened from the scene editor pops back to it instead of
    // dumping you on the storyboard — covers every close path (X, scrim,
    // Escape, Cancel) in one place.
    const m = get().modal;
    const back = m && "fromScene" in m && m.fromScene
      ? ({ kind: "scene", sceneId: m.fromScene } as Modal) : null;
    set({ modal: back, dockLifted: false });
  },
  askDirector(draft) {
    // The dock is a layout column with no stacking context of its own, so a
    // modal scrim covers it outright — prefilling the composer from inside a
    // modal put the text somewhere the user could not see, which read as the
    // button doing nothing. Lift the dock over the scrim rather than closing
    // the modal, so the work in progress behind it survives the detour.
    set({ chatOpen: true, dockDraft: draft, dockLifted: true });
  },
  // The generate dock is mounted by the library view itself and has no idea
  // the grid exists, so a card's "reuse" hands the recipe over here and the
  // dock picks it up. It is consumed once (`clearGenPreset`) — leaving it set
  // would re-apply it every time the dock re-renders and quietly undo edits.
  reuseGeneration(p) { set({ genPreset: p }); },
  clearGenPreset() { set({ genPreset: null }); },
  shelfRef(id) { set((s) => ({ refShelf: s.refShelf.includes(id) ? s.refShelf : [...s.refShelf, id] })); },
  clearShelf() { set({ refShelf: [] }); },
  shelfChat(id) {
    // `dockLifted` is deliberately not set here — it is only ever cleared by
    // closeModal, so setting it from a surface that has no modal open would
    // leave the dock lifted for the rest of the session. Callers inside a
    // modal pair this with askDirector, which does the lift and owns the
    // matching reset.
    set((s) => ({
      chatShelf: s.chatShelf.includes(id) ? s.chatShelf : [...s.chatShelf, id],
      chatOpen: true,
    }));
    persist(get());
  },
  clearChatShelf() { set({ chatShelf: [] }); },
}));

// Dev-only handle so the modal layer can be driven straight from a test
// without first reproducing the selection state that normally opens it.
// Stripped from production builds by the import.meta.env.DEV guard.
if (import.meta.env.DEV) {
  (window as unknown as { __ws?: typeof useWorkspaceStore }).__ws = useWorkspaceStore;
}

function persist(s: WorkspaceState) {
  try {
    const { panelOpen, panel, chatOpen, inspOpen, takesOpen, snap, autoAlign, divisor,
            pipOn, pipSize, pipX, pipY } = s;
    localStorage.setItem(LS_KEY, JSON.stringify({ panelOpen, panel, chatOpen, inspOpen, takesOpen,
                                                  snap, autoAlign, divisor, pipOn, pipSize, pipX, pipY }));
  } catch { /* storage disabled */ }
}
