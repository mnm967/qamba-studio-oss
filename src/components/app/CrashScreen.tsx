// What a render-time throw looks like instead of a blank window.
//
// WHY IT EXISTS. React unmounts the whole app on an uncaught render error — so
// without a boundary every one of them shows the same thing: a black window,
// no message, no way forward, and (in a packaged desktop build) no console to
// read either. "The app just goes blank" is unactionable both for whoever hit
// it and for whoever has to fix it.
//
// NOTHING IS SENT ANYWHERE. This build has no crash reporting: there is no
// service to report to and no account to attach a report to, so the error text
// on screen and the copy button beside it ARE the record. That is also why the
// message is shown in full rather than hidden behind a generic apology — the
// person reading it is the person who owns this studio, and the actual message
// is routinely the whole diagnosis (a missing node, a refused origin, a chunk
// that failed to load).
//
// STYLED FROM tokens.css ONLY, deliberately. This can render before any route
// chunk — and therefore before any route stylesheet — has loaded; that is in
// fact the likeliest moment for it, since a failed dynamic import is one of
// the errors it exists to catch. The same constraint `boot-load` is written
// under, and the styles live beside it for that reason.
import React from "react";

function Fallback({ error }: { error: unknown }) {
  const [copied, setCopied] = React.useState(false);
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error ?? "Unknown error");

  const copy = () => {
    const body = [
      message,
      error instanceof Error && error.stack ? `\n${error.stack}` : null,
    ].filter(Boolean).join("\n");
    void navigator.clipboard?.writeText(body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="crash" role="alert">
      <div className="crash-card">
        <h1>Something broke on this screen.</h1>
        <p className="crash-msg">{message}</p>
        <div className="crash-acts">
          {/* Reload rather than "try again": the state that produced the
              throw is still in memory, so re-rendering the same tree
              usually just throws again. A route chunk that failed to load —
              one of the errors most likely to land here — is fixed by
              exactly this and nothing else. */}
          <button className="crash-go" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="crash-alt" onClick={copy}>
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
        <p className="crash-id">Nothing was reported — copy the details if this needs fixing.</p>
      </div>
    </div>
  );
}

interface CrashState { error: unknown | null }

/** Wrap the app. A throw below this renders `Fallback` instead of unmounting
 *  the tree.
 *
 *  A class, because `getDerivedStateFromError` is the only way React offers to
 *  catch a render error and there is no hook form of it. */
export class CrashBoundary extends React.Component<{ children: React.ReactNode }, CrashState> {
  state: CrashState = { error: null };

  static getDerivedStateFromError(error: unknown): CrashState {
    return { error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // The console is the only sink there is, and in a packaged build nobody
    // can open it — which is exactly why the screen shows the message too.
    console.error("[crash]", error, info?.componentStack);
  }

  render() {
    if (this.state.error !== null) return <Fallback error={this.state.error} />;
    return this.props.children;
  }
}
