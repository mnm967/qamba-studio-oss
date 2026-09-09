"""Lore reaching the planner, and the document-to-entries pass.

The bug this file exists to prevent a second time is a silent one: a lore
entry's BODY never reached any model. `existing_bible` flattens every bible row
to `- [kind] name: identity_line or summary`, which is right for a character
(the reference sheets carry the rest) and drops the whole content of a lore
entry, whose content is nothing but writing. A world bible therefore arrived at
the writer as a list of titles, and nothing on any screen said so.
"""
import inspect
import json

import pytest

import llm


# --------------------------------------------------------------- lore_body ---

def test_lore_body_reads_the_current_field():
    assert llm.lore_body({"body": "The Concordat holds."}) == "The Concordat holds."


@pytest.mark.parametrize("key", ["notes", "bio", "appearance"])
def test_lore_body_still_finds_writing_saved_under_an_older_key(key):
    """Entries written by earlier versions of the bible UI hold their only copy
    under one of these. Reading only `body` would present an existing project's
    lore as empty — which reads as data loss, and invites the user to retype it
    on top of text that is still there."""
    assert llm.lore_body({key: "Old writing."}) == "Old writing."


def test_lore_body_prefers_the_newest_key_when_both_exist():
    # A migrating entry can transiently carry both; the current field wins.
    assert llm.lore_body({"body": "new", "notes": "old"}) == "new"


def test_lore_body_ignores_blank_and_non_string_values():
    assert llm.lore_body({"body": "   ", "notes": "real"}) == "real"
    assert llm.lore_body({"body": {"nested": 1}, "bio": "real"}) == "real"
    assert llm.lore_body({}) == ""
    assert llm.lore_body(None) == ""


# ------------------------------------------------------------ lore_context ---

def _entry(name, body, kind="lore"):
    return {"kind": kind, "name": name, "doc": {"body": body}}


def test_lore_context_carries_the_body_not_just_the_name():
    out = llm.lore_context([_entry("The Concordat", "Signed in ash. Nobody speaks the old names.")])
    assert "The Concordat" in out
    assert "Nobody speaks the old names" in out, "the body is the whole point"


def test_lore_context_ignores_every_other_kind():
    """A character's body text is their biography and it belongs in the sheet,
    not in a canon block the writer is told not to contradict."""
    bible = [
        _entry("Aki", "long silver hair", kind="character"),
        _entry("The Rooftop", "wet asphalt", kind="environment"),
        _entry("The Concordat", "Signed in ash."),
    ]
    out = llm.lore_context(bible)
    assert "Signed in ash" in out
    assert "silver hair" not in out
    assert "wet asphalt" not in out


def test_lore_context_is_empty_when_there_is_no_lore():
    assert llm.lore_context([]) == ""
    assert llm.lore_context([_entry("Aki", "x", kind="character")]) == ""
    # An entry with a summary but no body contributes nothing HERE — it is
    # already in `existing_bible`, and a heading with no text under it would
    # read as canon that was lost.
    assert llm.lore_context([{"kind": "lore", "name": "Thin", "doc": {}}]) == ""


def test_one_huge_entry_cannot_crowd_out_the_others():
    """The failure the per-entry cap prevents: someone pastes a 40KB history
    into one entry and every other piece of canon silently leaves the prompt."""
    bible = [_entry("Huge", "x" * 40000), _entry("Small", "The bridge is closed at night.")]
    out = llm.lore_context(bible)
    assert "The bridge is closed at night." in out
    assert len(out) <= llm.LORE_TOTAL_CHARS + 2000        # + headings/markers


def test_truncation_says_so_in_the_text():
    out = llm.lore_context([_entry("Huge", "y" * 40000)])
    assert "continues" in out, "a silent cut is indistinguishable from a model ignoring it"


def test_the_total_budget_is_enforced_across_entries():
    bible = [_entry(f"E{i}", "z" * llm.LORE_ENTRY_CHARS) for i in range(20)]
    out = llm.lore_context(bible)
    assert len(out) <= llm.LORE_TOTAL_CHARS + 4000
    # Whatever did not fit has to be reported — "no silent caps".
    assert "E0" in out, "the budget should spend on the first entries, not none"


def test_dropped_entries_are_logged(monkeypatch):
    said = []
    monkeypatch.setattr(llm, "log", lambda m: said.append(m))
    llm.lore_context([_entry(f"E{i}", "z" * llm.LORE_ENTRY_CHARS) for i in range(20)])
    assert any("budget" in m and "not inlined" in m for m in said), said


# ------------------------------------------ the planner actually sends it ---

def test_plan_storyboard_puts_lore_in_the_brief():
    """Pins the wiring, not just the helper. `lore_context` returning a perfect
    string is worth nothing if nothing puts it in the prompt — which is exactly
    the shape of the original bug."""
    src = inspect.getsource(llm.plan_storyboard)
    assert "lore_txt = lore_context(bible" in src
    assert '"project_lore": lore_txt' in src


def test_lore_is_separate_from_the_bible_manifest():
    """They are different instructions — a cast list to draw from vs. canon not
    to contradict — and merging them loses the second one."""
    src = inspect.getsource(llm.plan_storyboard)
    assert "project_lore_note" in src
    assert "Do not contradict" in src


# ----------------------------------------------------------- extract_lore ---

def test_extract_lore_is_registered_as_a_task():
    """An unregistered task id raises 'unknown llm task' at claim time, i.e.
    every queued extract fails after the user pressed the button."""
    src = inspect.getsource(llm.handle_llm_task)
    assert '"extract_lore": extract_lore' in src


def test_extract_lore_proposes_drafts_only(monkeypatch):
    """Confirmed entries are the planner's tier-1 prerogative. A 60-page import
    can propose dozens, and the point of confirmation is that nobody reads what
    arrives already confirmed."""
    inserted = _run_extract(monkeypatch, entries=[
        {"name": "The Concordat", "summary": "Nobody speaks the old names.", "body": "Signed in ash."}])
    assert len(inserted) == 1
    assert inserted[0]["status"] == "draft"
    assert inserted[0]["kind"] == "lore"
    assert inserted[0]["doc"]["body"] == "Signed in ash."
    # Provenance: which document proposed this, so a confirmed entry can be
    # traced back to its source.
    assert inserted[0]["doc"]["from_document"] == "doc-1"


def test_extract_lore_skips_names_already_in_the_bible(monkeypatch):
    """Two bible entries for one concept is two versions of the canon — and a
    second run over the same document is the normal way to reach that."""
    inserted = _run_extract(
        monkeypatch,
        entries=[{"name": "The Concordat", "summary": "s", "body": "b"},
                 {"name": "The Ashfall", "summary": "s", "body": "b"}],
        existing=["the concordat"])
    assert [r["name"] for r in inserted] == ["The Ashfall"]


def test_a_failing_window_does_not_lose_the_others(monkeypatch):
    """Same reasoning as parsing blocking scene-by-scene: one bad response must
    cost one window, not the whole document."""
    calls = {"n": 0}

    def flaky(system, messages, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("provider hiccup")
        return json.dumps({"entries": [{"name": "Survivor", "summary": "s", "body": "b"}]}), {}

    inserted = _run_extract(monkeypatch, complete=flaky, windows=2)
    assert [r["name"] for r in inserted] == ["Survivor"]


def test_unparseable_json_from_one_window_is_survivable(monkeypatch):
    calls = {"n": 0}

    def half_bad(system, messages, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return "I'm afraid I can't help with that.", {}
        return json.dumps({"entries": [{"name": "Survivor", "summary": "s", "body": "b"}]}), {}

    inserted = _run_extract(monkeypatch, complete=half_bad, windows=2)
    assert [r["name"] for r in inserted] == ["Survivor"]


def test_extract_lore_does_not_propose_characters_or_places():
    """They are separate bible kinds with their own reference art. An entry
    made here would be a second, picture-less copy of someone who exists —
    and `ref_plan_for` would have two names resolving to one person."""
    assert "Do NOT pull out individual characters" in llm.EXTRACT_CONTRACT


def test_the_summary_contract_asks_for_consequence():
    """That one sentence is what the planner sees for every scene; a label
    ('a treaty from the war') occupies the slot and says nothing."""
    assert "CONSEQUENCE" in llm.EXTRACT_CONTRACT


# --------------------------------------------------- lore has a timeline ---
# Flat, timeless lore contradicts itself as a series grows. "Grief unlocks the
# power" is true as of Ep1's ending and is reframed by Ep2's Stabilizing
# Presence reveal; held as co-equal canon, the planner cannot tell which is the
# current truth for Ep4, nor that Ep1 should still read as the naive
# understanding.

EPS = [{"id": "ep1", "idx": 0}, {"id": "ep2", "idx": 1}, {"id": "ep3", "idx": 2}]
ORDER = {"ep1": 0, "ep2": 1, "ep3": 2}


def _lore(name, body, when=None):
    doc = {"body": body}
    if when:
        doc["when"] = when
    return {"kind": "lore", "name": name, "doc": doc}


def test_untagged_lore_is_evergreen():
    """Every existing entry has no `when`, and must keep behaving exactly as it
    did — a feature that silently drops a project's whole bible on upgrade is
    worse than no feature."""
    assert llm.lore_status({}, ORDER, 0) == llm.LORE_IN_FORCE
    assert llm.lore_status({"when": None}, ORDER, 2) == llm.LORE_IN_FORCE
    assert llm.lore_status({"when": "garbage"}, ORDER, 1) == llm.LORE_IN_FORCE


def test_a_fact_does_not_exist_before_the_episode_that_establishes_it():
    doc = {"when": {"from": "ep2", "revealed": "ep2"}}
    assert llm.lore_status(doc, ORDER, 0) == llm.LORE_NOT_YET
    assert llm.lore_status(doc, ORDER, 1) == llm.LORE_IN_FORCE
    assert llm.lore_status(doc, ORDER, 2) == llm.LORE_IN_FORCE


def test_a_retcon_is_operating_before_it_is_revealed():
    """THE case the two fields exist for. Stabilizing Presence is true from Ep1
    and revealed in Ep2: in Ep1 the world must behave as though it holds, while
    no character may state it."""
    doc = {"when": {"from": "ep1", "revealed": "ep2"}}
    assert llm.lore_status(doc, ORDER, 0) == llm.LORE_UNREVEALED
    assert llm.lore_status(doc, ORDER, 1) == llm.LORE_IN_FORCE


def test_a_fact_can_stop_being_true():
    """The third case a single tag cannot express: "Rei doesn't know it's her
    power yet" is true in Ep1 and false from Ep2. Without an end bound it stays
    in context forever and by Ep4 the planner still thinks she doesn't know."""
    doc = {"when": {"from": "ep1", "revealed": "ep1", "until": "ep2"}}
    assert llm.lore_status(doc, ORDER, 0) == llm.LORE_IN_FORCE
    assert llm.lore_status(doc, ORDER, 1) == llm.LORE_SUPERSEDED
    assert llm.lore_status(doc, ORDER, 2) == llm.LORE_SUPERSEDED


def test_no_episode_means_the_old_flat_behaviour():
    """A one-shot project, or a plan with no episode resolved, must not start
    hiding lore."""
    doc = {"when": {"from": "ep3", "revealed": "ep3"}}
    assert llm.lore_status(doc, ORDER, None) == llm.LORE_IN_FORCE


def test_an_unresolvable_episode_is_treated_as_unbounded():
    """A deleted episode leaves dangling ids. Dropping the fact loses canon
    silently; keeping it is the pre-tagging behaviour."""
    doc = {"when": {"from": "ep-deleted", "revealed": "ep-deleted"}}
    assert llm.lore_status(doc, ORDER, 0) == llm.LORE_IN_FORCE


# ------------------------------------------ and it reaches the prompt ---

def test_unrevealed_lore_is_separated_and_labelled():
    bible = [
        _lore("Marble Exchange", "Touch-linked exchange, accurate throwing."),
        _lore("Stabilizing Presence", "Her leaving fractures him.",
              {"from": "ep1", "revealed": "ep2"}),
    ]
    out = llm.lore_context(bible, episodes=EPS, episode_id="ep1")
    assert "Marble Exchange" in out
    assert "Stabilizing Presence" in out, "a retcon must still shape the world"
    # …but under an instruction that forbids stating it.
    head, _, tail = out.partition("# Operating but NOT yet revealed")
    assert tail, "unrevealed facts need their own labelled section"
    assert "Stabilizing Presence" in tail
    assert "Marble Exchange" in head
    assert "no character may state" in tail.lower()


def test_by_the_reveal_episode_it_is_ordinary_canon():
    bible = [_lore("Stabilizing Presence", "Her leaving fractures him.",
                   {"from": "ep1", "revealed": "ep2"})]
    out = llm.lore_context(bible, episodes=EPS, episode_id="ep2")
    assert "Stabilizing Presence" in out
    assert "NOT yet revealed" not in out


def test_a_future_fact_is_absent_entirely():
    """Not hidden-but-present: absent. An Ep3 fact in an Ep1 prompt is a
    spoiler however it is labelled."""
    bible = [_lore("Alternate Selves", "Powers can be absorbed.",
                   {"from": "ep3", "revealed": "ep3"})]
    out = llm.lore_context(bible, episodes=EPS, episode_id="ep1")
    assert "Alternate Selves" not in out
    assert out == ""


def test_a_superseded_fact_is_absent():
    bible = [_lore("Rei doesn't know", "She thinks the reflections are grief.",
                   {"from": "ep1", "revealed": "ep1", "until": "ep2"})]
    assert "Rei doesn't know" not in llm.lore_context(bible, episodes=EPS, episode_id="ep2")
    assert "Rei doesn't know" in llm.lore_context(bible, episodes=EPS, episode_id="ep1")


def test_what_was_left_out_is_logged(monkeypatch):
    """No silent caps: an author wondering why the planner ignored a fact must
    be able to find out that it was filtered, not ignored."""
    said = []
    monkeypatch.setattr(llm, "log", lambda m: said.append(m))
    llm.lore_context([_lore("Future", "x", {"from": "ep3", "revealed": "ep3"}),
                      _lore("Past", "y", {"from": "ep1", "until": "ep2"})],
                     episodes=EPS, episode_id="ep2")
    assert any("not_yet" in m and "Future" in m for m in said), said
    assert any("superseded" in m and "Past" in m for m in said), said


def test_planner_passes_the_episode_it_is_writing():
    """The filter is worth nothing if the call site does not say which episode.
    Same failure shape as the original bug: correct helper, never wired."""
    src = inspect.getsource(llm.plan_storyboard)
    assert "lore_context(bible, episodes=all_eps, episode_id=ep_id)" in src


def test_extracted_entries_inherit_their_document_episode(monkeypatch):
    """Tagging has to be nearly free or it will not happen. A fact pulled from
    the Ep1 lore sheet is about Ep1."""
    inserted = _run_extract(
        monkeypatch,
        entries=[{"name": "Marble Exchange", "summary": "s", "body": "b"}],
        episode_id="ep1")
    assert inserted[0]["doc"]["when"] == {"from": "ep1", "until": None, "revealed": "ep1"}


def test_a_document_with_no_episode_extracts_evergreen_entries(monkeypatch):
    """A series bible is about no single episode, and guessing one would make
    every rule in it vanish from episode 1."""
    inserted = _run_extract(
        monkeypatch, entries=[{"name": "Marble Exchange", "summary": "s", "body": "b"}])
    assert "when" not in inserted[0]["doc"]


# ------------------------------------------------- the director can see it ---
# An indexed document that no tool can reach is invisible, and the director
# answers "there isn't a lore document attached yet" — truthfully, from its own
# point of view, about a document sitting in the database. `rag_search` had
# exactly one call site (plan_storyboard), so nothing in either toolset could
# read the corpus.

def test_search_lore_is_registered_in_the_worker_toolset():
    import director_tools as D
    assert any("search_lore" in str(s) for s in D.SCHEMAS)


def test_get_project_state_lists_lore_documents():
    """The tool whose description says to call it first, to learn what exists,
    has to mention the corpus — otherwise "can you see the lore doc?" is
    answered from a snapshot that structurally cannot contain one."""
    import director_tools as D
    src = inspect.getsource(D.execute)
    assert "_lore_doc_list(pid)" in src
    assert '"lore_documents"' in src


def test_get_project_state_selects_summary_for_lore_entries():
    """A lore entry has no identity_line by design, so selecting only that
    showed every lore row as a bare name with nothing under it."""
    import director_tools as D
    src = inspect.getsource(D.execute)
    assert "identity_line,summary" in src


def _stub_docs(monkeypatch, docs, chunks=()):
    import director_tools as D

    def fake_get(path):
        if path.startswith("rag_documents"):
            return docs
        if path.startswith("rag_chunks"):
            return list(chunks)
        return []
    monkeypatch.setattr(D.sb, "get", fake_get)
    return D


def test_search_lore_says_so_when_there_are_no_documents(monkeypatch):
    D = _stub_docs(monkeypatch, [])
    out = D._search_lore("proj-1", "the concordat")
    assert out["hits"] == []
    assert "no lore documents" in out["note"]


def test_search_lore_falls_back_to_keyword_without_embeddings(monkeypatch):
    """The fallback is the whole point. Semantic search needs OPENAI_API_KEY
    with quota; a user looking at an indexed document in the shelf must not be
    told there is no lore because a credit ran out."""
    D = _stub_docs(
        monkeypatch,
        [{"id": "d1", "title": "World Bible", "kind": "lore", "source": "file:wb.md"}],
        [{"document_id": "d1", "idx": 0, "content": "The Concordat was signed in ash."}])
    import llm
    monkeypatch.setattr(llm, "rag_search", lambda *a, **k: [])   # no embeddings
    out = D._search_lore("proj-1", "concordat")
    assert out["mode"] == "keyword"
    assert out["hits"][0]["text"] == "The Concordat was signed in ash."
    assert out["hits"][0]["title"] == "World Bible"
    # It must not let a literal match be reported as understanding.
    assert "not semantic" in out["note"]


def test_a_broken_semantic_pass_still_answers(monkeypatch):
    D = _stub_docs(
        monkeypatch,
        [{"id": "d1", "title": "World Bible", "kind": "lore", "source": None}],
        [{"document_id": "d1", "idx": 0, "content": "The Registry keeps two ledgers."}])
    import llm

    def boom(*a, **k):
        raise RuntimeError("no api key")
    monkeypatch.setattr(llm, "rag_search", boom)
    monkeypatch.setattr(D, "log", lambda *a: None)
    out = D._search_lore("proj-1", "ledgers")
    assert out["mode"] == "keyword"
    assert out["hits"]


def test_semantic_results_win_when_they_exist(monkeypatch):
    D = _stub_docs(monkeypatch, [{"id": "d1", "title": "World Bible", "kind": "lore", "source": None}])
    import llm
    monkeypatch.setattr(llm, "rag_search", lambda *a, **k: [
        {"title": "World Bible", "doc_kind": "lore", "similarity": 0.82,
         "content": "The Concordat forbids speaking the old names."}])
    out = D._search_lore("proj-1", "what do the names mean", 6)
    assert out["mode"] == "semantic"
    assert out["hits"][0]["similarity"] == 0.82


def test_a_non_string_query_does_not_raise_inside_the_tool(monkeypatch):
    """A model asked to "search the lore for 1947" can send a bare number. An
    exception here surfaces to the user as the feature being broken."""
    D = _stub_docs(monkeypatch, [{"id": "d1", "title": "T", "kind": "lore", "source": None}])
    import llm
    monkeypatch.setattr(llm, "rag_search", lambda *a, **k: [])
    assert D._search_lore("proj-1", 1947, "lots")["documents"]


def test_the_query_cannot_rewrite_the_postgrest_filter(monkeypatch):
    """A user's comma or asterisk lands in a URL filter — it has to be encoded
    as a value, or `search_lore("a,b")` becomes a different query."""
    import director_tools as D
    seen = []

    def fake_get(path):
        seen.append(path)
        if path.startswith("rag_documents"):
            return [{"id": "d1", "title": "T", "kind": "lore", "source": None}]
        return []
    monkeypatch.setattr(D.sb, "get", fake_get)
    import llm
    monkeypatch.setattr(llm, "rag_search", lambda *a, **k: [])
    D._search_lore("proj-1", "a,b*c")
    ilike = [p for p in seen if "ilike" in p]
    assert ilike, seen
    assert "," not in ilike[0].split("ilike.")[1].split("&")[0]


def test_documents_are_listed_even_when_the_search_finds_nothing(monkeypatch):
    """"No hits" and "no lore" are different answers, and conflating them is
    how the director concludes the project has no canon."""
    D = _stub_docs(monkeypatch, [{"id": "d1", "title": "World Bible", "kind": "lore", "source": None}])
    import llm
    monkeypatch.setattr(llm, "rag_search", lambda *a, **k: [])
    out = D._search_lore("proj-1", "something absent")
    assert out["hits"] == []
    assert [d["title"] for d in out["documents"]] == ["World Bible"]


# ------------------------------------------------ editing lore by chat ---
# The director could always propose bible edits, but it was never told where a
# lore entry's prose lives (`doc.body`) or that timing exists — so a lore edit
# through chat landed in the wrong key and the body silently never changed.

def test_the_doc_field_tells_the_director_where_lore_prose_goes():
    import director_tools as D
    schema = str(D.SCHEMAS)
    assert "`body`" in schema, "update_bible_entry must name lore's prose field"
    assert "set_lore_timing" in schema


def _eps():
    return [{"id": "e1", "idx": 0, "code": "EP01", "title": "One"},
            {"id": "e2", "idx": 1, "code": "EP02", "title": "Two"}]


@pytest.mark.parametrize("ref,want", [
    ("EP01", "e1"), ("ep01", "e1"), ("EP02", "e2"), ("ep2", "e2"),
    ("1", "e1"), ("2", "e2"), ("episode 2", "e2"), ("e2", "e2"),
])
def test_an_episode_resolves_by_whatever_the_director_calls_it(ref, want):
    """The model reads these labels off get_project_state; demanding a uuid it
    never saw is how a tool call becomes an invalid-input error."""
    import director_tools as D
    assert D._resolve_episode(_eps(), ref) == want


def test_an_unresolvable_episode_names_the_real_ones(monkeypatch):
    D = _timing_stub(monkeypatch, {"body": "x"})
    out = D._set_lore_timing("p1", {"name": "Rule", "from": "EP09"})
    assert "could not resolve" in out["error"]
    assert [e["code"] for e in out["episodes"]] == ["EP01", "EP02"]


def test_setting_from_also_sets_revealed(monkeypatch):
    """An ordinary fact is established when it is shown. Only a retcon separates
    the two, and that must be stated rather than defaulted into."""
    D = _timing_stub(monkeypatch, {"body": "x"})
    out = D._set_lore_timing("p1", {"name": "Rule", "from": "EP01"})
    assert D.PATCHED["doc"]["when"] == {"from": "e1", "revealed": "e1", "until": None}
    assert out["when"] == {"from": "EP01", "revealed": "EP01"}


def test_a_retcon_keeps_the_two_apart(monkeypatch):
    D = _timing_stub(monkeypatch, {"body": "x"})
    D._set_lore_timing("p1", {"name": "Rule", "from": "EP01", "revealed": "EP02"})
    w = D.PATCHED["doc"]["when"]
    assert w["from"] == "e1" and w["revealed"] == "e2"


def test_evergreen_clears_the_timing_without_touching_the_body(monkeypatch):
    D = _timing_stub(monkeypatch, {"body": "keep me", "when": {"from": "e1"}})
    D._set_lore_timing("p1", {"name": "Rule", "evergreen": True})
    assert "when" not in D.PATCHED["doc"]
    assert D.PATCHED["doc"]["body"] == "keep me"


def test_timing_applies_directly_rather_than_proposing(monkeypatch):
    """Timing is scoping, not story text. Routed through bible_revisions it
    would leave the planner on the old scope until someone opened the Bible
    page — the silent no-op this whole feature exists to avoid."""
    D = _timing_stub(monkeypatch, {"body": "x"})
    D._set_lore_timing("p1", {"name": "Rule", "from": "EP01"})
    assert D.INSERTED == [], "must not create a bible_revisions draft"
    assert D.PATCHED is not None


def test_an_unknown_entry_lists_what_does_exist(monkeypatch):
    D = _timing_stub(monkeypatch, None)
    out = D._set_lore_timing("p1", {"name": "Nope", "from": "EP01"})
    assert "no lore entry" in out["error"]
    assert out["lore_entries"] == ["Rule"]


def _timing_stub(monkeypatch, doc):
    """Stub the DB for _set_lore_timing. `doc` None = the entry doesn't exist."""
    import director_tools as D
    D.PATCHED, D.INSERTED = None, []

    def fake_get(path):
        if path.startswith("episodes"):
            return _eps()
        if path.startswith("bible_entries"):
            if "select=name" in path:
                return [{"name": "Rule"}]
            return [{"id": "x1", "name": "Rule", "doc": doc}] if doc is not None else []
        return []

    monkeypatch.setattr(D.sb, "get", fake_get)
    monkeypatch.setattr(D.sb, "patch", lambda path, body: setattr(D, "PATCHED", body))
    monkeypatch.setattr(D.sb, "insert", lambda t, r: D.INSERTED.append(r) or {"id": "r1"})
    return D


# ------------------------------------------------------------------ harness --

def _run_extract(monkeypatch, entries=None, existing=(), complete=None, windows=1,
                 episode_id=None):
    """Drive extract_lore against a stubbed DB and provider, returning the rows
    it tried to insert into bible_entries."""
    inserted = []
    chunks = [{"idx": i, "content": f"passage {i}. " + "w" * 100} for i in range(windows)]
    if windows > 1:
        # Force one window per chunk.
        monkeypatch.setattr(llm, "EXTRACT_WINDOW_CHARS", 1)

    def fake_get(path):
        if path.startswith("rag_documents"):
            return [{"id": "doc-1", "project_id": "proj-1", "kind": "lore",
                     "title": "World Bible", "episode_id": episode_id}]
        if path.startswith("rag_chunks"):
            return chunks
        if path.startswith("bible_entries"):
            return [{"name": n} for n in existing]
        return []

    def fake_insert(table, row):
        assert table == "bible_entries"
        inserted.append(row)
        return {**row, "id": f"e{len(inserted)}"}

    def fake_complete(system, messages, **kw):
        return json.dumps({"entries": entries or []}), {"cost_usd": 0.0}

    monkeypatch.setattr(llm.sb, "get", fake_get)
    monkeypatch.setattr(llm.sb, "insert", fake_insert)
    monkeypatch.setattr(llm.sb, "job_progress", lambda *a, **k: None)
    monkeypatch.setattr(llm.sb, "job_patch", lambda *a, **k: None)
    monkeypatch.setattr(llm.sb, "job_done", lambda *a, **k: None)
    monkeypatch.setattr(llm.sb, "cancel_requested", lambda *a, **k: False)
    monkeypatch.setattr(llm.sb, "record_cost", lambda *a, **k: None)
    monkeypatch.setattr(llm, "pick_backend", lambda *a, **k: "openai-compat")
    monkeypatch.setattr(llm, "complete", complete or fake_complete)
    llm.extract_lore({"id": "job-1", "payload": {"document_id": "doc-1", "project_id": "proj-1"}})
    return inserted
