// Cloned voices: read them, make one, remove one.
//
// Making a clone is TWO writes and a job, and the order matters. The row is
// inserted `pending` FIRST so the picker can show it immediately with a
// spinner — a hosted registration is a network round trip to Fish, and a UI
// that shows nothing until it returns looks like the upload failed. The job
// then does the part that needs a credential (invariant #1: the provider key
// never leaves the pod) and resolves the row to `ready` or `error`.
import { supabase } from "../supabase";
import { enqueueJob, USER_PRIORITY } from "./jobs";
import type { VoiceClone } from "./types";

/** Clones usable in a project: the project's own, plus the caller's
 *  project-less personal ones.
 *
 *  Two queries rather than an `.or()` because PostgREST's or-filter and RLS
 *  compose confusingly here, and because "mine, everywhere" is genuinely a
 *  different question from "this project's" — a personal clone follows you
 *  between projects, a project one is shared with its collaborators. */
export async function loadVoiceClones(projectId?: string | null): Promise<VoiceClone[]> {
  const mine = supabase.from("voice_clones").select("*").is("project_id", null);
  const here = projectId
    ? supabase.from("voice_clones").select("*").eq("project_id", projectId)
    : null;
  const [a, b] = await Promise.all([mine, here ?? Promise.resolve({ data: [] })]);
  if (a.error) throw a.error;
  const rows = [...((a.data ?? []) as VoiceClone[]),
    ...(((b as { data?: VoiceClone[] }).data ?? []))];
  // A project row and a personal row are distinct records; dedupe only by id.
  const seen = new Map(rows.map((r) => [r.id, r]));
  return [...seen.values()].sort((x, y) => x.name.localeCompare(y.name));
}

export async function createVoiceClone(input: {
  name: string;
  provider: VoiceClone["provider"];
  sampleAssetId: string;
  sampleText?: string;
  projectId?: string | null;
  /** register it with the user's OWN key, on this machine */
  here?: boolean;
}): Promise<VoiceClone> {
  const { data, error } = await supabase.from("voice_clones").insert({
    name: input.name.trim().slice(0, 80),
    provider: input.provider,
    sample_asset_id: input.sampleAssetId,
    sample_text: input.sampleText?.trim() || null,
    project_id: input.projectId ?? null,
    status: "pending",
  }).select().single();
  if (error) throw error;
  const clone = data as VoiceClone;
  await enqueueJob({
    // YOUR KEY MEANS YOUR MACHINE, the same rule the voice tab's own generate
    // follows: registering a clone spends the provider key, the pod cannot
    // read this keychain, and `handlers/voice` is one of the kinds the
    // desktop's Python runs. Named rather than "every key on the machine" —
    // reaching for one nobody chose is the silent spend `routeHere` refuses.
    kind: "voice_clone", lane: input.here ? "local" : "cpu", priority: USER_PRIORITY,
    project_id: input.projectId ?? undefined,
    payload: {
      voice_clone_id: clone.id, label: `voice · ${clone.name}`,
      ...(input.here ? { byok_providers: [input.provider] } : {}),
    },
  });
  return clone;
}

/** Remove a clone. The reference CLIP is left alone on purpose: it is an
 *  ordinary library asset the user uploaded, and deleting someone's recording
 *  because they removed a voice made from it is more damage than the action
 *  implies. The bin is where media gets deleted. */
export async function deleteVoiceClone(id: string): Promise<void> {
  const { error } = await supabase.from("voice_clones").delete().eq("id", id);
  if (error) throw error;
}
