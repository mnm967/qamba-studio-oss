"""Which provider key this process may spend.

There is one answer and it is the environment — `plan_run` reads the key out
of the OS keychain in Rust and places it into this process's env, so nothing
here goes looking for a credential anywhere else. What is worth pinning is the
PROVIDER LIST, which lives in three languages and is silent when they
disagree: Rust decides where a key may be SENT, the browser decides which
cards are OFFERED, and this module decides what may be SPENT. A provider the
browser offers and this module does not know is a key somebody pastes in and
nothing ever reads.
"""
import os
import re

import byok


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def test_a_key_in_the_environment_is_the_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-here")
    assert byok.key_for({"id": "j1"}, "openai") == "sk-here"


def test_an_absent_key_is_none_rather_than_a_setup_hint(monkeypatch):
    # `providers.require_env` is what turns absence into a sentence; a hint
    # returned here would be spent as though it were a credential.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert byok.key_for({"id": "j1"}, "anthropic") is None


def test_a_blank_key_is_treated_as_absent(monkeypatch):
    # An empty variable is what a setup script writes for a name it has no
    # value for, and sending an empty Authorization header is a 401 the caller
    # reads as a REJECTED key rather than as a missing one.
    monkeypatch.setenv("FAL_KEY", "")
    assert byok.key_for({"id": "j1"}, "fal") is None


def test_an_unknown_provider_is_none_and_not_an_exception():
    assert byok.key_for({"id": "j1"}, "not-a-provider") is None


def test_a_caller_may_name_the_variable_itself(monkeypatch):
    # `llm._key` was written against its own names and passes them; the table
    # is the default rather than the law.
    monkeypatch.setenv("OPENAI_BASE_KEY", "sk-odd")
    assert byok.key_for({"id": "j1"}, "openai", env_name="OPENAI_BASE_KEY") == "sk-odd"


def test_providers_for_reports_only_what_is_actually_set(monkeypatch):
    for name in byok.ENV_FOR.values():
        monkeypatch.delenv(name, raising=False)
    assert byok.providers_for() == set()
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert byok.providers_for() == {"google"}


def test_every_provider_has_a_variable_and_every_variable_a_provider():
    # A provider with no env name can never be spent; a name shared by two
    # providers spends one key under two labels.
    assert set(byok.ENV_FOR) == byok.PROVIDERS
    assert len(set(byok.ENV_FOR.values())) == len(byok.ENV_FOR), "two providers share a variable"


def test_the_refusal_names_the_screen_that_fixes_it():
    # A sentence naming a fix with nowhere to go is the refusal this build's
    # pickers exist to end — and here the fix really is a screen.
    msg = byok.member_refusal("openai", "OpenAI")
    assert "OpenAI" in msg and "engine window" in msg


def test_the_provider_list_agrees_across_all_three_languages():
    """Every disagreement here is silent: a provider Rust allows and this
    module does not know is a key nothing reads, and one the browser offers
    and Rust refuses is a card whose Check button can only ever fail.
    """
    rust = _read("src-tauri/src/secrets.rs")
    # `allowed_hosts`' match arms: `"openai" => &[...]`
    body = rust.split("fn allowed_hosts", 1)[1].split("\n}", 1)[0]
    rust_ids = set(re.findall(r'"([a-z]+)" =>', body))
    assert rust_ids, "the allowed_hosts scanner found nothing — it is broken"

    ts = _read("src/lib/byokProviders.ts")
    block = ts.split("export const BYOK_PROVIDERS", 1)[1]
    ts_ids = set(re.findall(r'\n\s*id: "([a-z]+)"', block))
    assert ts_ids, "the BYOK_PROVIDERS scanner found nothing — it is broken"

    assert rust_ids == byok.PROVIDERS, (
        f"rust has {rust_ids - byok.PROVIDERS}, worker has {byok.PROVIDERS - rust_ids}")
    assert ts_ids == byok.PROVIDERS, (
        f"browser has {ts_ids - byok.PROVIDERS}, worker has {byok.PROVIDERS - ts_ids}")
