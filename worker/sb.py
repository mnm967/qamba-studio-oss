"""The pipeline's database access — PostgREST over loopback.

One module owns every DB touch: job lifecycle, asset registry, job_timings,
the director's journal. Handlers never build REST URLs themselves.

THERE IS NO DATABASE SERVER. A project's rows are a JSON file the app owns,
and the app answers PostgREST for them on a loopback port (`dbproxy.rs` +
`localRest.ts`). The wire format is what the two sides share: this module
speaks the same PostgREST it always did, the app answers out of the open
project, and neither knows anything about the other. That is the entire
reason running the studio's pipeline against a file was affordable, and it is
why the variables below keep their `SUPABASE_` names — they are the slots the
app fills, not a service anyone signs up for.

ONE CREDENTIAL, AND IT IS A PER-RUN TOKEN. `planner.rs` opens a session
(`dbproxy::open_session`), which returns a random token good for exactly one
project and for as long as this process lives, and puts it in the bearer slot.
A loopback port is reachable by every process running as this user, so that
token is the whole access control: a request without it never reaches the
webview at all.

PostgREST needs BOTH headers and they mean different things — `apikey` admits
the request, `Authorization` decides who is asking — so both are sent even
though only one of them carries anything here.

DELIBERATELY NO SERVICE-KEY PATH. The cloud build had one, for a worker that
ran every account's jobs; it bypassed row-level security by design. Nothing
in this build has any use for such a credential, and a code path that would
pick one up out of the environment is an invitation to put one in an
installer. There is no way to configure that here.
"""
import json
import os
import time

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
REST = f"{SUPABASE_URL}/rest/v1"

ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")
ACCESS_TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN")

if not (ANON_KEY and ACCESS_TOKEN):
    # Named rather than a KeyError on whichever variable is looked at first:
    # a traceback naming one of them says nothing about the pair.
    raise RuntimeError(
        "sb needs SUPABASE_ANON_KEY + SUPABASE_ACCESS_TOKEN — the app sets "
        "both when it spawns the pipeline (see src-tauri/src/planner.rs)")

_APIKEY, _BEARER = ANON_KEY, ACCESS_TOKEN

HEADERS = {
    "apikey": _APIKEY,
    "Authorization": f"Bearer {_BEARER}",
    "Content-Type": "application/json",
}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def get(path):
    r = requests.get(f"{REST}/{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


# --------------------------------------------------------------- journal ---
# A JOURNAL of what a director turn WROTE — the twin of director/changes.js.
# `llm.chat` opens one around the tool loop; every write below records onto
# it while it is open (reads never); the ops land on the assistant message as
# a `changes` block, and the dock's Revert replays them backwards in the
# browser. Same three rules as the JS: an update reads the rows it is about
# to touch FIRST and keeps only the patched columns; the plan is the journal
# reversed; a queued job is cancelled, never deleted. A write with no filter
# cannot be journaled without reading a whole table and is recorded as
# unbounded, so the revert says which part it could not undo.
_JOURNAL = {"ops": None}
# The turn's OWN bookkeeping is not an edit: the chat row is painted on every
# streamed delta, and journaling those would cost a read per paint and put
# the transcript itself on the revert list.
_NO_JOURNAL = frozenset({"chat_messages"})


def journal_begin():
    _JOURNAL["ops"] = []


def journal_end():
    ops = _JOURNAL["ops"] or []
    _JOURNAL["ops"] = None
    return ops


def _journal(op):
    if _JOURNAL["ops"] is not None and op.get("table") not in _NO_JOURNAL:
        _JOURNAL["ops"].append(op)


def _select_path(path, cols):
    """`table?filters` -> `table?filters&select=<cols>`; None for a path with
    no filters at all (nothing here writes unbounded)."""
    q = path.find("?")
    if q < 0:
        return None
    table, rest = path[:q], path[q + 1:]
    params = [x for x in rest.split("&") if x and not x.startswith("select=")]
    if not params:
        return None
    return f"{table}?{'&'.join(params + ['select=' + cols])}"


def _table_of(path):
    return path.split("?")[0]


def delete(path):
    """Row delete by filter. Used by the director's storyboard tools — cutting a
    scene has to actually remove it, and beats cascade with it."""
    if _JOURNAL["ops"] is not None and _table_of(path) not in _NO_JOURNAL:
        sel = _select_path(path, "*")
        if sel is None:
            _journal({"op": "delete", "table": _table_of(path), "unbounded": True})
        else:
            try:
                rows = get(sel)
            except Exception:  # noqa: BLE001 — the delete still happens
                rows = []
            _journal({"op": "delete", "table": _table_of(path),
                      "rows": rows if isinstance(rows, list) else []})
    r = requests.delete(f"{REST}/{path}", headers=HEADERS, timeout=30)
    r.raise_for_status()


def patch(path, body, want_rows=False):
    if _JOURNAL["ops"] is not None and _table_of(path) not in _NO_JOURNAL:
        keys = list((body or {}).keys()) if isinstance(body, dict) else []
        sel = _select_path(path, ",".join(["id", "entry_id", "asset_id", "collection_id"] + keys))
        if sel is None:
            _journal({"op": "update", "table": _table_of(path), "unbounded": True})
        else:
            try:
                before = get(sel)
            except Exception:  # noqa: BLE001
                before = []
            _journal({"op": "update", "table": _table_of(path), "keys": keys,
                      "before": before if isinstance(before, list) else []})
    h = dict(HEADERS)
    if want_rows:
        h["Prefer"] = "return=representation"
    r = requests.patch(f"{REST}/{path}", headers=h, data=json.dumps(body), timeout=30)
    r.raise_for_status()
    return r.json() if want_rows else None


#: The one queue in this build — the lane `localWorker` claims. Every other
#: lane name in the pipeline is a default written for a studio that is not
#: part of it, and `insert` corrects onto this rather than refusing: routing
#: elsewhere was never a choice anybody made.
LANE = "local"


def insert(table, body):
    # A FOLLOW-UP JOB CAN ONLY RUN HERE, and this is the one place that can say
    # so for all of them. A dozen handlers write `"lane": "cpu"` or `"gpu"`
    # into a job they queue — `tts` queues an `asset_ingest`, `launch_render`
    # queues a `master_pass` per block — and nothing claims those names: such a
    # job is not slow, it is unreachable, and it sits `queued` forever on a
    # screen that reports nothing wrong.
    #
    # Corrected here rather than at each site for the reason `enqueueJob` does
    # the same in the browser: a rule repeated a dozen times is one that gets
    # forgotten once. A kind this build cannot run then fails IMMEDIATELY with
    # a sentence naming it (`plan_cli._dispatch`), which is a much better
    # outcome than a queue that quietly never moves.
    if table == "jobs":
        if isinstance(body, list):
            body = [{**b, "lane": LANE} for b in body]
        else:
            body = {**body, "lane": LANE}
    h = dict(HEADERS)
    h["Prefer"] = "return=representation"
    r = requests.post(f"{REST}/{table}", headers=h, data=json.dumps(body), timeout=30)
    r.raise_for_status()
    rows = r.json()
    if _JOURNAL["ops"] is not None:
        for row in (rows if isinstance(rows, list) else [rows]):
            _journal({"op": "insert", "table": table,
                      "id": (row or {}).get("id") if isinstance(row, dict) else None})
    return rows[0] if isinstance(rows, list) else rows


def upsert(table, body, on_conflict):
    h = dict(HEADERS)
    h["Prefer"] = "return=representation,resolution=merge-duplicates"
    r = requests.post(f"{REST}/{table}?on_conflict={on_conflict}", headers=h,
                      data=json.dumps(body), timeout=30)
    r.raise_for_status()
    rows = r.json()
    return rows[0] if isinstance(rows, list) else rows


def rpc(fn, args):
    r = requests.post(f"{REST}/rpc/{fn}", headers=HEADERS, data=json.dumps(args), timeout=30)
    r.raise_for_status()
    return r.json() if r.text else None


# ------------------------------------------------------------------ jobs -----
def claim_next_job(lanes, worker_id):
    """Claim the highest-priority ready job in the given lanes (deps done),
    via the SKIP LOCKED RPC — multi-worker safe."""
    rows = rpc("claim_next_job", {"p_lanes": lanes, "p_worker": worker_id})
    return rows[0] if rows else None


def job_patch(jid, body):
    body = {**body, "updated_at": now()}
    patch(f"jobs?id=eq.{jid}", body)


def job_progress(jid, fraction, note=None, eta_seconds=None):
    """`fraction=None` updates the note alone — some things worth saying (a
    backend falling over to the next one) don't move the bar."""
    body = {} if fraction is None else {"progress": round(max(0.0, min(1.0, float(fraction))), 3)}
    if note is not None:
        body["progress_note"] = str(note)[:200]
    if eta_seconds is not None:
        body["eta_seconds"] = int(eta_seconds)
    job_patch(jid, body)


def job_row(jid):
    rows = get(f"jobs?id=eq.{jid}&select=id,status,cancel_requested")
    return rows[0] if rows else None


def cancel_requested(jid):
    row = job_row(jid)
    return bool(row and row.get("cancel_requested"))


def job_done(jid, **fields):
    job_patch(jid, {"status": "done", "progress": 1, **fields})


def job_canceled(jid, note="canceled"):
    job_patch(jid, {"status": "canceled", "progress_note": note})


def fail_dependents(jid, _depth=0):
    """Error out queued jobs that depend (transitively) on a failed/canceled
    job so the queue never deadlocks on a dead dependency."""
    if _depth > 20:
        return
    try:
        rows = get(f"jobs?status=eq.queued&depends_on=cs.{{{jid}}}&select=id")
    except Exception:
        return
    for r in rows:
        try:
            job_patch(r["id"], {"status": "error", "error_msg": f"dependency {jid} failed"})
            fail_dependents(r["id"], _depth + 1)
        except Exception:
            pass


def record_timing(job, wall_seconds, *, frames=None, steps=None, cold_load=False,
                  load_seconds=None, gpu=None):
    try:
        insert("job_timings", {
            "job_id": job["id"],
            "model_id": job.get("model_id") or job.get("model"),
            "kind": job.get("kind"),
            "width": (job.get("payload") or {}).get("width") or job.get("width"),
            "height": (job.get("payload") or {}).get("height") or job.get("height"),
            "frames": frames, "steps": steps,
            "cold_load": bool(cold_load), "load_seconds": load_seconds,
            "wall_seconds": round(float(wall_seconds), 2), "gpu": gpu,
        })
    except Exception as e:
        print("record_timing failed:", e)


def record_cost(job, amount_usd, category, *, provider=None, quantity=None,
                unit=None, note=None, estimate=False):
    try:
        insert("cost_ledger", {
            "project_id": job.get("project_id"), "job_id": job["id"],
            "category": category, "provider": provider,
            "amount_usd": round(float(amount_usd), 6),
            "quantity": quantity, "unit": unit, "note": note, "estimate": estimate,
        })
        patch(f"jobs?id=eq.{job['id']}", {"cost_usd": round(float(amount_usd), 4)})
    except Exception as e:
        print("record_cost failed:", e)


# ----------------------------------------------------------------- assets ----
def register_asset(b2_key, kind, *, project_id=None, content_type=None, bytes_=None,
                   width=None, height=None, duration_ms=None, fps=None,
                   origin="generated", source_job_id=None, meta=None, tags=None):
    """Every B2 object the worker writes gets a registry row (GC authority)."""
    return upsert("assets", {
        "b2_key": b2_key, "kind": kind, "project_id": project_id,
        "content_type": content_type, "bytes": bytes_, "width": width,
        "height": height, "duration_ms": duration_ms, "fps": fps,
        "origin": origin, "source_job_id": source_job_id,
        "meta": meta or {}, "tags": tags or [],
    }, on_conflict="b2_key")


def asset_by_id(aid):
    rows = get(f"assets?id=eq.{aid}")
    return rows[0] if rows else None


def assets_by_ids(ids):
    if not ids:
        return {}
    rows = get(f"assets?id=in.({','.join(ids)})")
    return {r["id"]: r for r in rows}


# ------------------------------------------------------------ model catalog --
_catalog_cache = {"at": 0.0, "rows": None}


def model_catalog(max_age=300):
    if _catalog_cache["rows"] is None or time.time() - _catalog_cache["at"] > max_age:
        try:
            _catalog_cache["rows"] = {r["id"]: r for r in get("model_catalog?select=*")}
            _catalog_cache["at"] = time.time()
        except Exception as e:
            print("model_catalog load failed:", e)
            if _catalog_cache["rows"] is None:
                _catalog_cache["rows"] = {}
    return _catalog_cache["rows"]


# --------------------------------------------------------- lora visibility --
# An admin can restrict a LoRA to admins. The browser never receives a
# restricted key (model_catalog_visible rewrites the catalog per caller), but a
# job row is just JSON and the worker holds the service key, so the pod is the
# place this has to actually hold.
_lora_vis_cache = {"at": 0.0, "keys": None}
_admin_cache = {"at": 0.0, "ids": None}


def restricted_loras(max_age=120):
    """LoRA keys an ordinary member may not render with."""
    if _lora_vis_cache["keys"] is None or time.time() - _lora_vis_cache["at"] > max_age:
        try:
            rows = get("lora_visibility?select=lora_key,visibility&visibility=eq.admins")
            _lora_vis_cache["keys"] = {r["lora_key"] for r in rows}
            _lora_vis_cache["at"] = time.time()
        except Exception as e:
            print("lora_visibility load failed:", e)
            # FAIL OPEN, deliberately: this is a curation control, not a
            # security boundary, and a database blip must not silently strip
            # the adapters out of a render the owner is paying for. The browser
            # side already withheld the key from anyone not allowed it.
            if _lora_vis_cache["keys"] is None:
                _lora_vis_cache["keys"] = set()
    return _lora_vis_cache["keys"]


_model_vis_cache = {"at": 0.0, "ids": None, "keys": None}


def restricted_models(max_age=120):
    """(catalog ids, model_map keys) an ordinary member may not render with.

    Both spellings, because a job carries the catalog id in `model_id` and the
    model_map key in `payload.model_key` — `modelKeyOf`'s exception table exists
    precisely because those two disagree. The key is written alongside the id by
    the client that restricted it, so the mapping is not re-derived here.
    """
    if _model_vis_cache["ids"] is None or time.time() - _model_vis_cache["at"] > max_age:
        try:
            rows = rpc("restricted_models", {}) or []
            _model_vis_cache["ids"] = {r["model_id"] for r in rows if r.get("model_id")}
            _model_vis_cache["keys"] = {r["model_key"] for r in rows if r.get("model_key")}
            _model_vis_cache["at"] = time.time()
        except Exception as e:
            print("restricted_models load failed:", e)
            if _model_vis_cache["ids"] is None:
                _model_vis_cache["ids"], _model_vis_cache["keys"] = set(), set()
    return _model_vis_cache["ids"], _model_vis_cache["keys"]


def admin_ids(max_age=120):
    if _admin_cache["ids"] is None or time.time() - _admin_cache["at"] > max_age:
        try:
            rows = get("profiles?select=id&role=eq.admin")
            _admin_cache["ids"] = {r["id"] for r in rows}
            _admin_cache["at"] = time.time()
        except Exception as e:
            print("admin_ids load failed:", e)
            if _admin_cache["ids"] is None:
                _admin_cache["ids"] = set()
    return _admin_cache["ids"]
