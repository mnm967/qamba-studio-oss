"""Which queue an image render belongs in.

THERE IS ONE QUEUE IN THIS BUILD. The cloud version had a third render plane —
the studio's own provider keys, spent server-side — and this module decided
which rows could take it. Here every render is either this machine's ComfyUI or
this machine's own API key, and both are claimed off `lane: "local"` by the
desktop worker.

Kept as a module rather than inlined so the two call sites in
`director_tools.py` still read as a decision that was made, and so a fork that
adds a server-side key route has one place to make it again.
"""


def studio_hosted(row):
    """True when a render of this row would be billed to somebody other than
    the person at the keyboard. Never, here."""
    return False


def image_lane(row, default="local"):
    """The queue an `image_gen` for this row belongs in.

    `local` throughout: the desktop worker claims that lane and routes by the
    MODEL — a `local:` id to its own recipe table, a mapped id to the bundled
    Python, a key of the user's own to the provider adapter.
    """
    return default
