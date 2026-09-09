# Make `import h3_timing` etc. work regardless of pytest's invocation cwd.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# `sb.py` reads its credentials at import time, so anything that touches the DB
# module — director_tools, llm — is unimportable without them. In the app these
# are the loopback address and the per-run token `planner.rs` mints; here they
# are placeholders, and the tests that go near the DB stub `sb.get`/`sb.patch`.
# A real value in the environment still wins.
os.environ.setdefault("SUPABASE_URL", "http://127.0.0.1:1")
os.environ.setdefault("SUPABASE_ANON_KEY", "local")
os.environ.setdefault("SUPABASE_ACCESS_TOKEN", "test-token")
