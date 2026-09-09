import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import devServerApi from "./dev-server-api.js";

const { version } = createRequire(import.meta.url)("./package.json");

// `devServerApi` is the DEV playback diagnostic and nothing else — see that
// file. Nothing in a production build reaches it.
export default defineConfig({
  plugins: [react(), devServerApi()],
  // Read from package.json so it cannot drift from the version the desktop
  // updater compares against — `tauri.conf.json`'s own version is the other
  // half of that pair, and `scripts/tauri_build.mjs` checks they agree.
  define: { __APP_VERSION__: JSON.stringify(version) },
  // SOURCE MAPS ARE NOT BUILT. There is no crash reporter to feed them to
  // (see `components/app/CrashScreen.tsx`), so the only thing shipping them
  // would do is publish the whole frontend source beside the bundle. Anyone
  // debugging a build of their own can turn this on for their own build.
  build: { sourcemap: false },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // THE WATCHER MUST NOT DESCEND INTO THE RUST BUILD TREE, and on Windows
    // that is load-bearing rather than tidy. Cargo EXCLUSIVELY LOCKS a build
    // script's .exe while it runs it, chokidar's fs.watch on a locked file
    // raises EBUSY as an *unhandled error event*, and an unhandled error on
    // the dev server is a dead dev server — which is exactly what
    // `tauri dev` runs as its beforeDevCommand, so the whole desktop build
    // dies mid-compile with a stack trace about a file nobody edited. macOS
    // does not lock a running executable, so this never fires there and the
    // omission was invisible. Ignoring it is independently correct: it is
    // gigabytes of build output the frontend never imports.
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
