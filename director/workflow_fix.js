// The one thing a model is asked about a broken ComfyUI workflow.
//
// WHY THIS IS IN director/ AND NOT IN src/lib. It is imported by BOTH the
// browser (`src/lib/workflowRepair.ts`) and a Vercel function
// (`api/director/fix-workflow.js`), which is exactly what this directory is
// for — the rule `tool_parity` already states: a module shared by the
// functions and the frontend belongs here rather than being copied.
//
// THE SERVER BUILDS THE PROMPT, NOT THE CALLER. The route takes faults and a
// class list, never a system string: a client that could post its own system
// prompt to a paid backend is an open relay wearing a feature's name. The
// browser imports the same builder so it can show exactly what will be sent.
//
// THE ASK IS DELIBERATELY TINY. Almost every workflow failure is answered by
// arithmetic on ComfyUI's own reply — a `value_not_in_list` carries the full
// list of legal values, so "you do not have this checkpoint" needs no model at
// all. What is left, and all this file covers, is substituting a node class
// that is not installed for one that is. Widening it to "repair this graph"
// was considered and rejected: a model handed a whole graph rewrites wiring it
// cannot verify, and a rewired graph that validates is far more dangerous than
// one that fails, because it renders something and calls that success.

/** Hard cap on how many missing classes go in one ask. */
export const MAX_FAULTS = 24;
/** Above this the class list is a token bill, not context. A real engine
 *  reports ~850 and the pod ~1700, so this is a truncation in practice — the
 *  prompt says so rather than implying the model saw everything. */
export const MAX_CLASSES = 600;

export function fixSystem() {
  return (
    "You substitute ComfyUI node classes, and nothing else.\n"
    + "\n"
    + "You are given node classes a workflow needs that are NOT installed, and the list of "
    + "classes that ARE installed. Reply with JSON and no prose:\n"
    + '{"substitutions":[{"missing":"<class>","use":"<installed class>","why":"<one sentence>"}]}\n'
    + "\n"
    + "RULES\n"
    + "1. `use` MUST be copied verbatim from the installed list. A class that is not in it "
    + "fails exactly like the one it replaces, except the user was told it was fixed.\n"
    + "2. Substitute only when the replacement takes the same inputs and does the same job. "
    + "A node with a similar NAME is not a substitute.\n"
    + "3. Omit the entry when there is no honest equivalent. An empty list is a good answer "
    + "and is often the right one — most custom nodes have no stock replacement.\n"
    + "4. Do not invent nodes, do not propose rewiring, do not suggest new nodes to add. "
    + "Changing one class is the only edit available to you."
  );
}

/**
 * The user half: what is missing, and what the engine has.
 *
 * `inputs` are included because they are the whole basis for rule 2 — a
 * substitute has to take the same wires, and the class name alone cannot say
 * whether it does.
 */
export function fixUser(faults, installed) {
  const use = (faults || []).slice(0, MAX_FAULTS);
  const lines = use.map((f) => {
    const ins = (f.inputs || []).join(", ");
    return `- ${f.class_type} (node #${f.node ?? "?"})${ins ? `, inputs: ${ins}` : ""}`;
  });
  const all = installed || [];
  const shown = all.slice(0, MAX_CLASSES);
  const listed = shown.length
    ? `Installed classes (${shown.length}${all.length > shown.length
        ? ` of ${all.length}, truncated` : ""}):\n${shown.join(", ")}`
    // Saying this rather than omitting it: a model with no list will happily
    // invent plausible class names, and the validation would then drop every
    // one with nothing to show for the call.
    : "The installed class list is unavailable, so propose nothing.";
  return `Missing classes:\n${lines.join("\n")}\n\n${listed}`;
}

/**
 * A model's reply, reduced to substitutions that name a class the engine has.
 *
 * THE VALIDATION IS THE FEATURE, and it lives here so both callers get it: the
 * worst a confabulating model can do is produce nothing. Returns [] for
 * anything unparseable rather than throwing — a failed repair suggestion must
 * not become a failed screen.
 */
export function parseFixReply(reply, installedSet) {
  let parsed;
  try {
    const s = String(reply ?? "");
    const at = s.indexOf("{");
    if (at < 0) return [];
    parsed = JSON.parse(s.slice(at, s.lastIndexOf("}") + 1));
  } catch {
    return [];
  }
  const out = [];
  for (const sub of parsed?.substitutions ?? []) {
    if (!sub?.missing || !sub?.use) continue;
    if (installedSet?.size && !installedSet.has(sub.use)) continue;   // invented
    out.push({ missing: String(sub.missing), use: String(sub.use),
               why: String(sub.why ?? "").trim() });
  }
  return out;
}
