import React from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import "../styles/v2.css";

/** Minimal v2 page chrome: glass bar with back link + title. Pages render
 * inside a centered column sharing the legacy palette tokens. */
export default function V2Shell({
  title,
  eyebrow,
  backTo = "/",
  actions,
  wide = false,
  children,
}: {
  title: string;
  eyebrow?: string;
  backTo?: string | null;
  actions?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={"v2" + (wide ? " v2-wide" : "")}>
      <header className="v2-bar">
        {backTo != null && (
          <Link className="v2-back" to={backTo} aria-label="Back">
            <ChevronLeft size={18} />
          </Link>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <div className="v2-bar-title">{title}</div>
        </div>
        {actions}
      </header>
      {children}
    </div>
  );
}
