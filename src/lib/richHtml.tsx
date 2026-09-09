// Render someone else's HTML without handing them the app.
//
// A Civitai model description is author-written HTML — 5KB on a typical
// workflow, 30KB on the chatty ones — and it is the only place the recipe
// lives: which nodes to install, which weights, what the sampler settings
// should be. Showing it as flattened text loses the lists and headings that
// make it readable; showing it with `dangerouslySetInnerHTML` hands a public
// site's user-submitted markup script access to an origin that holds a
// Supabase session. Neither is acceptable, so this is the third option: parse
// with the browser's own HTML parser (which does NOT run scripts on a
// `text/html` string) and rebuild an ALLOW-LIST of tags as React elements.
//
// The rules that make it safe are all "no" rules:
//   · nothing outside ALLOW is emitted as an element,
//   · DROP subtrees are not walked at all — otherwise `<script>` contributes
//     its source as visible text,
//   · the only attributes that survive are href/src/alt, and href/src must
//     parse as http(s) — `javascript:` and `data:` never reach the DOM,
//   · a link is a button that calls openExternal, never an <a href> the
//     webview could navigate itself.
import React from "react";
import { ExternalLink } from "lucide-react";
import { openExternal } from "./desktop.ts";

/** Tags we render, mapped to the element actually emitted. */
const ALLOW: Record<string, string> = {
  p: "p", br: "br", hr: "hr",
  h1: "h4", h2: "h4", h3: "h5", h4: "h5", h5: "h6", h6: "h6",
  strong: "strong", b: "strong", em: "em", i: "em", u: "u", s: "s", del: "s",
  ul: "ul", ol: "ol", li: "li",
  blockquote: "blockquote", code: "code", pre: "pre",
  a: "a", img: "img",
  table: "table", thead: "thead", tbody: "tbody", tr: "tr", td: "td", th: "th",
};

/** Subtrees that are skipped whole rather than descended into. */
const DROP = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "math", "noscript",
  "template", "form", "input", "button", "select", "textarea", "link", "meta",
]);

const httpUrl = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(raw, "https://civitai.com");
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
};

function walk(node: Node, key: number, depth: number): React.ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag)) return null;
  if (depth > 24) return el.textContent;               // pathological nesting

  const kids = Array.from(el.childNodes)
    .map((c, i) => walk(c, i, depth + 1))
    .filter((c) => c !== null && c !== "");

  const out = ALLOW[tag];
  // Unknown but harmless (div, span, section…): keep the content, drop the box.
  if (!out) return kids.length ? <React.Fragment key={key}>{kids}</React.Fragment> : null;

  if (out === "br") return <br key={key} />;
  if (out === "hr") return <hr key={key} className="ns-rh-hr" />;

  if (out === "img") {
    const src = httpUrl(el.getAttribute("src"));
    if (!src) return null;
    return (
      <img key={key} src={src} alt={el.getAttribute("alt") ?? ""} loading="lazy"
           referrerPolicy="no-referrer" className="ns-rh-img" />
    );
  }

  if (out === "a") {
    const href = httpUrl(el.getAttribute("href"));
    const label = el.textContent?.trim() || href || "";
    if (!href) return <React.Fragment key={key}>{kids}</React.Fragment>;
    return (
      <button key={key} className="ns-rh-a" title={href}
              onClick={() => void openExternal(href)}>
        {label}<ExternalLink size={10} style={{ opacity: 0.7, marginLeft: 3, marginBottom: -1 }} />
      </button>
    );
  }

  return React.createElement(out, { key }, kids.length ? kids : null);
}

/**
 * Parse and render. Returns null for empty input so a caller can decide what
 * an absent description looks like.
 */
export default function RichHtml({ html, className }: { html?: string | null; className?: string }) {
  const nodes = React.useMemo(() => {
    if (!html?.trim()) return null;
    // `parseFromString(…, "text/html")` builds an inert document: scripts do
    // not run, <img> does not load, and nothing here is ever adopted into the
    // live tree — only read.
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.body.childNodes).map((n, i) => walk(n, i, 0));
  }, [html]);

  if (!nodes) return null;
  return <div className={`ns-rh${className ? ` ${className}` : ""}`}>{nodes}</div>;
}
