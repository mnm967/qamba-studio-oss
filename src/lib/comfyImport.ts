// The two strings the ComfyUI round trip turns on.
//
// Their own module because `db/customWorkflows.ts` imports the supabase client,
// which `node --test` cannot resolve — the same reason `scoreTrack` and
// `audioGraph` are tested by parsing rather than importing. These are pure, so
// they get to be tested properly instead.
//
// Both are load-bearing in ways that are invisible when wrong: the NAME is what
// the library shows, and the SOURCE URL is the key that makes a second save
// update the row rather than adding another beside it.

/**
 * What an imported ComfyUI file is called in the library.
 *
 * The `Qamba - ` prefix is OURS — it exists so a staged file is recognisable in
 * ComfyUI's own sidebar — and carrying it back would name every round trip
 * after the app rather than after the workflow.
 */
export const comfyImportName = (file: string) =>
  file.replace(/^Qamba - /, "").replace(/\.json$/, "").trim() || "Untitled workflow";

/** How a row records which ComfyUI file it came from. `source_url` is free text
 *  and nothing else writes this shape, so it doubles as the key a re-import
 *  updates through. */
export const comfySourceUrl = (file: string) => `comfyui:${file}`;
