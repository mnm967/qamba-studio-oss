"""Which provider key this process may spend.

THERE IS ONE ANSWER HERE AND IT IS THE ENVIRONMENT. The cloud build had two
credentials to choose between — the studio's own key, and an encrypted copy a
user had shared with the render pod — because one worker ran every account's
jobs. This build runs one person's jobs on their own machine, and the key
arrives the way `plan_run` puts it there: read out of the OS keychain by Rust
and placed into the child's environment, so `os.environ` IS the user's key.

Kept as a module rather than inlined into `llm.py` because three modules ask
(`llm`, `providers`-shaped adapters, `genmedia`) and the answer to "may I spend
this" is worth having one name for.
"""
import os

#: The providers this build knows how to call. The same list
#: `src-tauri/src/secrets.rs::allowed_hosts` enforces on the way out — a
#: provider absent from either is one nothing can reach.
PROVIDERS = {"openai", "anthropic", "google", "fal", "minimax",
             "alibaba", "elevenlabs", "fish"}

#: provider -> the variable its key arrives in.
ENV_FOR = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GEMINI_API_KEY",
    "fal": "FAL_KEY",
    "minimax": "MINIMAX_API_KEY",
    "alibaba": "DASHSCOPE_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
    "fish": "FISH_API_KEY",
}


def is_admin(job=None):
    """Whether this job may spend a credential nobody at this keyboard owns.

    Always true: there is nobody else. Kept so the call sites still say what
    they mean rather than losing the distinction entirely.
    """
    return True


def key_for(job, provider, env_name=None):
    """The key for `provider`, or None.

    `env_name` overrides the table for a caller that already knows the
    variable — `llm._key` passes the one it was written against.
    """
    name = env_name or ENV_FOR.get(provider)
    if not name:
        return None
    return os.environ.get(name) or None


def providers_for(job=None):
    """Every provider this process holds a key for."""
    return {p for p in PROVIDERS if key_for(job, p)}


def member_refusal(provider, label=None):
    """What to say when a render needs a key nobody has added.

    Names the screen that fixes it: on this build a provider key is pasted
    into the engine window, and the message is the only place that says so.
    """
    return (f"this needs a {label or provider} API key — add one under "
            f"API keys in the engine window")


def reset_cache():
    """No cache to drop. Kept so callers written against the shared-key
    lookup still compile."""
