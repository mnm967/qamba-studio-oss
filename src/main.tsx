import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { watchTitlebar } from "./lib/titlebar";
import { CrashBoundary } from "./components/app/CrashScreen";
import "./styles/tokens.css";

const Workspace = React.lazy(() => import("./routes/Workspace"));
const TimelineDemoLazy = React.lazy(() => import("./routes/TimelineDemoPage"));
const WorkspaceDemoLazy = React.lazy(() => import("./routes/WorkspaceDemo"));
const DesktopPreviewLazy = React.lazy(() => import("./routes/DesktopPreview"));
const ChatPageLazy = React.lazy(() => import("./routes/ChatPage"));
const WizardPageLazy = React.lazy(() => import("./routes/WizardPage"));

// A real fallback, not null: with null the first visit is a bare dark window
// for the whole download+parse of the route chunk, which reads as a hang.
// Styled from tokens.css only — no route stylesheet exists yet at this point.
const S = ({ children }: { children: React.ReactNode }) => (
  <React.Suspense fallback={<div className="boot-load"><i /><span>Loading…</span></div>}>
    {children}
  </React.Suspense>
);

// Desktop-UI testing in a browser tab. tauri-driver cannot automate a macOS
// WKWebView (its own README lists macOS as "[Todo]"), so the desktop screens
// are exercised by faking the bridge instead — dev builds only, and only when
// the URL explicitly asks with ?desktop=<machine>. See src/lib/desktop.mock.ts.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("desktop")) {
  const { installDesktopMock } = await import("./lib/desktop.mock");
  installDesktopMock();
}

// Dev-only playback diagnostic (src/lib/playbackDiag.ts): media-element census,
// media events and main-thread stalls, reported to the Vite dev server. The
// production build drops this branch.
if (import.meta.env.DEV) {
  const { startPlaybackDiag } = await import("./lib/playbackDiag");
  startPlaybackDiag();
}

// Reserve the macOS traffic lights' corner before the first paint. The desktop
// window is `titleBarStyle: "Overlay"`, so the buttons are drawn over the page
// and the top bar's own wordmark sits under them until something says how wide
// that corner is. No-op in the browser. Deliberately not awaited.
void watchTitlebar();

// THE LOCAL PLANE IS INSTALLED BEFORE THE FIRST RENDER.
//
// Every query in the app is routed by which project is open
// (src/lib/localPlane.ts), so a project opened from a bookmarked URL has to
// find its plane already there — installing it from an effect would send that
// first fetch nowhere, and leave a screen nothing refetches.
//
// It gates the MOUNT rather than being awaited at the top level: the target
// browsers do not have top-level await (measured — the build refuses it), and
// the wait is desktop-only: a browser tab has no disk to read.
const mount = (app: React.ReactElement) =>
  ReactDOM.createRoot(document.getElementById("root")!).render(app);

const localPlaneReady: Promise<unknown> = (window as any).__TAURI__
  ? import("./lib/localPlane")
      .then((m) => m.bootLocalPlane())
      .catch((e) => {
        // A failure here costs the local projects and nothing else, so the
        // app carries on — and that is exactly what makes it invisible, least
        // of all in a packaged build with no inspector. Say it loudly.
        console.error("[local] the local plane did not start", e);
      })
  : Promise.resolve();

void localPlaneReady.then(() => mount(
  <React.StrictMode>
    <CrashBoundary>
    <BrowserRouter>
      {/* A harness for the desktop-only screens, which describe the machine
          rather than any project and render only when the URL asks for a
          mocked bridge. It REPLACES the app tree rather than stacking over it,
          so the thing under test is not sitting behind the workspace. */}
      {import.meta.env.DEV && location.pathname.startsWith("/ui/") ? (
        <Routes>
          <Route path="/ui/:screen" element={<S><DesktopPreviewLazy /></S>} />
        </Routes>
      ) : (
      <Routes>
        <Route path="/" element={<S><Workspace view="projects" /></S>} />
        <Route path="/projects" element={<Navigate to="/" replace />} />
        <Route path="/queue" element={<Navigate to="/" replace />} />
        <Route path="/workflows" element={<S><Workspace view="workflows" /></S>} />
        <Route path="/library" element={<S><Workspace view="library" /></S>} />
        <Route path="/project/:pid/ep/:eid/timeline" element={<S><Workspace view="timeline" /></S>} />
        <Route path="/project/:pid/ep/:eid/storyboard" element={<S><Workspace view="storyboard" /></S>} />
        <Route path="/project/:pid/ep/:eid/bible" element={<S><Workspace view="bible" /></S>} />
        <Route path="/project/:pid/ep/:eid/library" element={<S><Workspace view="library" /></S>} />
        <Route path="/project/:pid/ep/:eid/workflows" element={<S><Workspace view="workflows" /></S>} />
        <Route path="/project/:pid/bible" element={<S><Workspace view="bible" /></S>} />
        <Route path="/project/:pid" element={<S><Workspace view="timeline" /></S>} />
        {/* full-page chat + wizard remain available (the dock links here for long sessions) */}
        <Route path="/project/:pid/chat/:tid?" element={<S><ChatPageLazy /></S>} />
        <Route path="/project/:pid/wizard" element={<S><WizardPageLazy /></S>} />
        {import.meta.env.DEV && (
          <Route path="/timeline-demo" element={<S><TimelineDemoLazy /></S>} />
        )}
        {import.meta.env.DEV && (
          <Route path="/ws-demo" element={<S><WorkspaceDemoLazy /></S>} />
        )}
        <Route path="/*" element={<Navigate to="/" replace />} />
      </Routes>
      )}
    </BrowserRouter>
    </CrashBoundary>
  </React.StrictMode>
));
