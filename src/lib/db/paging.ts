// Reading past PostgREST's row cap.
//
// Supabase caps every response at `db.max_rows` — 1000 on this project — and
// that cap OVERRIDES the `.limit()` in the query. There is no error and nothing
// in the body to say the list was cut, so the failure is always silent and
// always looks like "there just isn't any more".
//
// Two shapes hit it, and they want opposite fixes:
//
//   * Code that COUNTS or SUMS rows must not read them at all — aggregate in
//     Postgres (`asset_counts`, `collection_counts`, `rag_chunk_counts`,
//     `cost_ledger_totals`, `job_timing_stats`). A capped tally reports the
//     first 1000 rows as the whole table: the Costs page said $110.54 of a real
//     $334.49, and the library sidebar said 1,000 of a real 3,031.
//
//   * Code that genuinely needs the ROWS — a grid — pages, which is what this
//     module is for.
export const ROW_CAP = 1000;

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/**
 * Fetch the first `want` rows of an ordered query, in `ROW_CAP`-sized requests.
 *
 * The library grid pages by widening its LIMIT rather than by offsetting, so
 * that every refetch returns a longer prefix of one ordered list and no row can
 * shift between pages. That is a good design and it is not what broke: what
 * broke is that the widened limit stopped being honoured at 1000, after which
 * the grid returned exactly 1000 rows, concluded from the short page that the
 * list was exhausted, and reported itself complete — on an account with 3,031
 * assets. This keeps the caller's contract ("the first N of this order") and
 * only issues a second request once N passes the cap, so nothing about a
 * normal-sized library changes.
 *
 * `build` must return a FRESH query each call: a PostgrestBuilder is thenable
 * and single-use, so reusing one across two awaits resolves the same request
 * twice. Within one call the pages are consecutive ranges over a live table, so
 * a concurrent insert can still shift a row between them — far narrower than a
 * scrolling offset pager, and self-correcting, since the next refetch rebuilds
 * the whole prefix from zero.
 */
export async function pageThrough<T>(
  build: () => { range(from: number, to: number): Page<T> },
  want: number,
): Promise<T[]> {
  const out: T[] = [];
  while (out.length < want) {
    const size = Math.min(ROW_CAP, want - out.length);
    const { data, error } = await build().range(out.length, out.length + size - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    // A short page means the list is exhausted. It is also what keeps this
    // correct if `db.max_rows` is ever changed: the constant only decides how
    // big to ask for, never how much came back.
    if (rows.length < size) break;
  }
  return out;
}
