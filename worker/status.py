"""Where the pipeline's Python says what it is doing.

One line, and the tail of the last few — two things read them: the `stderr`
the desktop shows when a job fails, and `comfy.log_tail`, which folds
ComfyUI's own messages into the same stream.

IT USED TO BE THE POD'S HEARTBEAT. The cloud build published a `pod_status`
row every five seconds — GPU utilisation, VRAM, session seconds — and ran the
idle auto-stop that turned a $3.36/hr box off after a quiet window. Neither
exists on a machine somebody is sitting at: there is nothing metered to report
and nothing to switch off, and the log is what is left.

Stdlib only, which is now load-bearing rather than incidental: this module is
imported by nearly every handler, and it used to pull `requests`, `comfy` and
`sb` in behind it.
"""
import collections
import time

WORKER_TAIL = collections.deque(maxlen=8)


def log(*a):
    ts = time.strftime("%H:%M:%S")
    msg = " ".join(str(x) for x in a)
    WORKER_TAIL.append((ts, msg))
    print(f"[{ts}]", msg, flush=True)
