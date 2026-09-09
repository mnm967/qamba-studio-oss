// Which project a background render writes to, passed rather than inferred.
//
// The desktop worker is the one thing in this app that reads and writes rows
// for a project the user is not necessarily looking at. Everything else is a
// screen, and a screen is always inside the project it is querying — which is
// what lets `supabase.from` decide the plane from the URL (see localPlane.ts).
// A render does not have that luxury: it can be one project's job, queued
// five minutes ago, finishing while the user is three clicks away in another.
// So the project travels WITH the job, as three functions — see
// `localJobIO` in localPlane.ts, which builds one per project.
import { registerAsset } from "./db/assets.ts";
import { supabase } from "./supabase";
import { uploadMedia } from "./upload.js";
import type { Asset } from "./db/types.ts";

export interface JobIO {
  /** A query builder for the project this job belongs to. */
  from: (table: string) => any;
  /** Put the bytes where this project keeps media. */
  upload: (file: Blob, key: string, onProgress?: (f: number) => void) => Promise<{ key: string }>;
  /** Register them, so the rest of the app can see them. */
  register: (a: Parameters<typeof registerAsset>[0]) => Promise<Asset>;
}

/**
 * The OPEN project's own plane — what a render started from a screen writes to.
 *
 * It is only ever a DEFAULT, and only safe as one because a screen is always
 * inside the project it is querying: `supabase.from` reads the plane off the
 * URL, so a render queued from the composer and finished by the same call
 * lands where the composer is. The WORKER never takes it — it holds every
 * project's queue at once and passes each job its own (see `localJobIO`),
 * because a render finishing while a different project is on screen would
 * otherwise publish itself into that one.
 */
export const OPEN_PROJECT_IO: JobIO = {
  from: (table) => supabase.from(table),
  upload: (file, key, onProgress) =>
    uploadMedia(
      file instanceof File ? file : new File([file], key.split("/").pop()!), key, onProgress),
  register: (a) => registerAsset(a),
};
