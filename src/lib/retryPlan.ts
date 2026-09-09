// The graph half of a job retry, as pure functions with no imports.
//
// Retrying a failed job means inserting fresh rows and rebuilding `depends_on`
// against the new ids, and BOTH ways of getting that wrong are silent: keep a
// dependency that can never turn `done` and the retry sits in the queue
// forever (claim_next_job simply never selects it, with nothing on screen to
// say why); insert a row before the job it depends on has its replacement and
// it points at the OLD failed id, which is the same deadlock. Neither raises.
//
// db/jobs.ts reaches supabase at import, so this lives on its own — same
// reason realtimeTables.ts does.

export interface RetryNode {
  id: string;
  depends_on?: string[] | null;
}

/** A dependency outside the retry set is only worth keeping if it can still
 *  reach `done` — claim_next_job's condition. `error` and `canceled` never
 *  will, so carrying one forward would strand the retry permanently. */
export const CAN_STILL_COMPLETE = new Set(["done", "queued", "running"]);

export function liveDeps(rows: { id: string; status: string }[]): Set<string> {
  return new Set(rows.filter((r) => CAN_STILL_COMPLETE.has(r.status)).map((r) => r.id));
}

export interface RetryStep<T extends RetryNode> {
  job: T;
  /** OLD ids. Chain ids get mapped through the remap as rows are inserted;
   *  everything else is an outside dependency that is kept verbatim. */
  deps: string[];
}

/** Insertion order for a retry, dependency-first.
 *
 * Kahn's algorithm over the chain's internal edges only. Anything left over
 * after the queue drains is part of a cycle — unreachable in practice, since
 * `depends_on` is written at enqueue time against rows that already exist, but
 * dropping those rows beats emitting an order that is a lie.
 */
export function planRetry<T extends RetryNode>(
  chain: T[], live: ReadonlySet<string> = new Set(),
): RetryStep<T>[] {
  const inChain = new Set(chain.map((j) => j.id));
  const deps = new Map<string, string[]>(
    chain.map((j) => [j.id, (j.depends_on ?? []).filter((d) => inChain.has(d))]),
  );
  const done = new Set<string>();
  const out: RetryStep<T>[] = [];
  let moved = true;
  while (moved) {
    moved = false;
    for (const j of chain) {
      if (done.has(j.id)) continue;
      if (!deps.get(j.id)!.every((d) => done.has(d))) continue;
      done.add(j.id);
      moved = true;
      out.push({
        job: j,
        deps: (j.depends_on ?? []).filter((d) => inChain.has(d) || live.has(d)),
      });
    }
  }
  return out;
}

/** The new `depends_on` for one step, given what has been inserted so far. */
export function remapDeps(deps: string[], remap: ReadonlyMap<string, string>): string[] {
  return deps.map((d) => remap.get(d) ?? d);
}
