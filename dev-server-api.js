// Vite dev plugin — the DEV PLAYBACK DIAGNOSTIC, and nothing else.
//
// It used to mirror a set of server-side routes (uploads, presigned PUTs, pod
// power) so a browser could reach them from the dev server. This build has no
// server side: media is written to disk by the app itself, every provider call
// is made in the app's native layer with a key from the OS keychain, and there
// is no box to switch on. What is left is the one thing that genuinely needs a
// process outside the page.
//
// WHY THAT ONE THING NEEDS A SERVER. `src/lib/playbackDiag.ts` reports what
// the player's media elements are doing, and the desktop webview under
// `tauri dev` has NO INSPECTOR to read a console from — so the page POSTs its
// lines here and this appends them to a file. The same channel carries a small
// command queue in the other direction, because a bare `tauri dev` binary has
// no bundle identifier and cannot be driven by anything outside it.
//
// NEVER SHIPPED, and it cannot be: this middleware is Vite's alone and a
// production build does not run it. The page's own calls are behind
// `import.meta.env.DEV`, which a build drops.

export default function devServerApi() {
  return {
    name: "qamba-dev-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const u = new URL(req.url, "http://localhost");
        if (!u.pathname.startsWith("/api/diag")) return next();
        try {
          // The remote's command queue: a JSON array in a local file, handed
          // to the page once and cleared. Read-only from the network's side —
          // this only ever READS that file, so a client that can reach the dev
          // server can log lines and nothing more.
          //
          // `os.tmpdir()`, not `/tmp`: on a Mac that is a per-user directory
          // under `/var/folders`, and writing the file to the wrong one is an
          // hour of wondering why nothing is picked up.
          if (u.pathname === "/api/diag/cmd") {
            const [fs, os, path] = await Promise.all([
              import("node:fs"), import("node:os"), import("node:path")]);
            const file = process.env.QAMBA_DIAG_CMD
              || path.join(os.tmpdir(), "qamba-diag-cmd.json");
            let txt = "";
            try { txt = fs.readFileSync(file, "utf8"); } catch { /* nothing queued */ }
            if (!txt.trim()) { res.statusCode = 204; return res.end(); }
            try { fs.writeFileSync(file, ""); } catch { /* best effort */ }
            res.setHeader("content-type", "application/json");
            return res.end(txt);
          }
          if (u.pathname === "/api/diag") {
            if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const [{ appendFileSync }, os, path] = await Promise.all([
              import("node:fs"), import("node:os"), import("node:path")]);
            const file = process.env.QAMBA_DIAG_LOG
              || path.join(os.tmpdir(), "qamba-playback-diag.log");
            appendFileSync(file, Buffer.concat(chunks));
            res.statusCode = 204;
            return res.end();
          }
          return next();
        } catch (e) {
          console.error("dev-api error", e);
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ error: String(e?.message || e) }));
        }
      });
    },
  };
}
