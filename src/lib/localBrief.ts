// The wizard's INTERVIEW, run on this machine.
//
// The interview is not the director. Its toolset is three things — write the
// brief down, read what the project already has, read the lore — and its
// contract says so in as many words ("its job is to ask and to write down, not
// to run the studio"). It had no browser implementation at all, and that cost
// two separate things:
//
//  1. A TURN ANSWERED HERE WAS HANDED THE DIRECTOR'S FORTY EDITING TOOLS AND
//     NOT `note_brief`. That tool is the whole point of the interview — it is
//     what writes `chat_threads.brief`, the row the wizard renders beside the
//     conversation — and it lived only in `api/director/brief.js` and the
//     worker. So a desktop interview talked, was offered `add_scene` and
//     `plan_storyboard` instead, and never wrote a word of the brief down.
//
//  2. A LOCAL PROJECT HAD NOWHERE TO RUN AT ALL. `/api/director/brief` looks
//     the project up in Supabase and a local project's rows are a file on this
//     machine, so it can only ever answer 404 — which is exactly what it did,
//     on the first project a desktop build makes, since those default to local.
//     This machine is the only place that interview can happen.
//
// EVERY CALL HERE GOES THROUGH `supabase.from`, so `planeRouter` sends it to
// whichever plane the project is on — the same property `localDirector` gets
// for the director's own forty by routing its PostgREST paths through
// `localRest`. Two mechanisms because the two modules are shaped differently
// (one holds a client, the other holds paths); one rule, which is that a tool
// must read and write the rows that are on screen.
//
// The MERGE, the mirror it hands back and the schema are the shared ones
// (`director/brief.js`), so the three runners cannot drift on what a patch
// means — only on how they reach the database.

import { supabase } from "./supabase";
import {
  mergeBrief, noteBriefResult, NOTE_BRIEF_DESC, NOTE_BRIEF_SCHEMA, STATE_DESC,
} from "../../director/brief.js";
import { SEARCH_LORE_DESC, SEARCH_LORE_SCHEMA } from "../../director/lore_schema.js";

/** An Anthropic-shaped tool definition, the shape `runLocalDirectorTurn` takes. */
export interface BriefToolDef {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface BriefToolCtx {
  projectId: string;
  threadId: string;
  /** The brief so far. `note_brief` merges into it IN PLACE, because the model
   *  may call it twice in one turn and the second patch has to land on the
   *  first one's result rather than on the row as it was when the turn began. */
  brief: Record<string, unknown>;
  /** Called with the merged brief after each write, so the panel beside the
   *  conversation moves DURING the turn rather than at the end of it — the
   *  hosted route emits its own `brief` event for the same reason. */
  onBrief?: (brief: Record<string, unknown>) => void;
}

export const BRIEF_TOOLS: BriefToolDef[] = [
  { name: "note_brief", description: NOTE_BRIEF_DESC, input_schema: NOTE_BRIEF_SCHEMA },
  { name: "get_project_state", description: STATE_DESC,
    input_schema: { type: "object", properties: {} } },
  { name: "search_lore", description: SEARCH_LORE_DESC, input_schema: SEARCH_LORE_SCHEMA },
];

export const BRIEF_TOOL_NAMES = new Set(BRIEF_TOOLS.map((t) => t.name));

/**
 * Run one interview tool.
 *
 * Errors are RETURNED rather than thrown, the same as every other tool runner
 * here: a failed read is something the model can be told about and work around,
 * and a thrown one would end a turn the user is watching.
 */
export async function runBriefTool(
  name: string,
  input: Record<string, unknown>,
  ctx: BriefToolCtx,
): Promise<unknown> {
  try {
    if (name === "note_brief") {
      ctx.brief = mergeBrief(ctx.brief, input) as Record<string, unknown>;
      const { error } = await supabase.from("chat_threads")
        .update({ brief: ctx.brief }).eq("id", ctx.threadId);
      // The row is what the wizard renders and what the next turn reads back
      // for its own context, so a failed write is not a detail — an interview
      // that thinks it wrote something down asks about it once and never again.
      if (error) return { error: `could not save the brief: ${error.message}` };
      ctx.onBrief?.(ctx.brief);
      // The PATCH goes back too, so an entry the merge dropped is reported
      // rather than answered with `noted: true` over a list that lost it.
      return noteBriefResult(ctx.brief, input);
    }

    if (name === "get_project_state") {
      const [project, episodes, bible, lore] = await Promise.all([
        supabase.from("projects")
          .select("id,title,medium,genre,style,aspect,logline").eq("id", ctx.projectId).maybeSingle(),
        supabase.from("episodes")
          .select("id,idx,code,title,status").eq("project_id", ctx.projectId).order("idx"),
        supabase.from("bible_entries")
          .select("kind,name,status,identity_line,summary").eq("project_id", ctx.projectId).order("kind"),
        supabase.from("bible_entries")
          .select("id,name,summary").eq("project_id", ctx.projectId).eq("kind", "lore").order("name"),
      ]);
      return {
        project: project.data ?? null,
        episodes: episodes.data ?? [],
        bible: bible.data ?? [],
        lore_documents: lore.data ?? [],
      };
    }

    if (name === "search_lore") {
      // TEXT MATCH ONLY, and it says so. The hosted one embeds the query with
      // `OPENAI_API_KEY`, which is server-side and stays there (invariant #4),
      // so the semantic path does not exist in a browser — and "no lore
      // matched" and "I could not look properly" are different answers.
      // Same wording as `localDirector`'s, deliberately: it is the same
      // limitation and the model should read one sentence about it, not two.
      const q = String(input.query ?? "").trim().replace(/[%,()]/g, " ");
      if (!q) return { results: [], note: "empty query" };
      const limit = Math.max(1, Math.min(20, Number(input.limit) || 8));
      const { data, error } = await supabase.from("bible_entries")
        .select("id,name,summary,doc")
        .eq("project_id", ctx.projectId).eq("kind", "lore")
        .or(`name.ilike.*${q}*,summary.ilike.*${q}*`)
        .limit(limit);
      if (error) return { error: `could not search the lore: ${error.message}` };
      return {
        results: data ?? [],
        note: "Text match only. Semantic lore search needs the studio's embedding "
            + "key, which a turn answered on this machine does not have — switch to a "
            + "hosted backend if a search comes back thinner than you expect.",
      };
    }

    return { error: `unknown tool ${name}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
