// Minimal markdown → React for chat messages.
//
// Every LLM answers in markdown whether or not you ask it to, and rendering it
// raw means the reader parses `**Beat 1 (4s)**` by eye. This covers what
// models actually emit — headings, bold/italic, inline and fenced code, nested
// bullets, numbered lists, blockquotes, links — and nothing else.
//
// It returns React nodes rather than an HTML string on purpose: no
// dangerouslySetInnerHTML anywhere, so model output can never inject markup,
// which matters more here than in most places because the local backend is
// explicitly uncensored and the text is untrusted by construction.
import React from "react";

/** How an `asset:` image is drawn. Supplied by the caller rather than resolved
 *  here: turning an asset UUID into a thumbnail needs a row lookup, and this
 *  module deliberately imports nothing — that is what keeps it safe to point at
 *  untrusted output. Absent, the alt text stands in. */
export type AssetRenderer = (id: string, alt: string) => React.ReactNode;

interface Opts { asset?: AssetRenderer }

/** Inline spans: `code`, **bold**, *italic*, [text](url), ![alt](asset:uuid).
 *  Applied in that order so a URL inside backticks stays literal. */
function inline(text: string, key: string, opts: Opts = {}): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // One pass, longest-delimiter-first, so ** wins over *. The image
  // alternative precedes the link one so `![a](b)` is taken whole rather than
  // as a literal `!` followed by a link.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-i${i++}`;
    if (tok.startsWith("`")) {
      out.push(<code key={k} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("![")) {
      // ONLY `asset:<uuid>`. A general image URL would let untrusted model
      // output make the browser fetch an arbitrary remote host on render —
      // the same class of thing the javascript:/data: href check below refuses.
      const close = tok.indexOf("](");
      const alt = tok.slice(2, close);
      const src = tok.slice(close + 2, -1);
      const id = /^asset:([0-9a-fA-F-]{8,})$/.exec(src)?.[1];
      const node = id && opts.asset ? opts.asset(id, alt) : null;
      out.push(node
        ? <React.Fragment key={k}>{node}</React.Fragment>
        : <span key={k} className="md-code">{alt || src}</span>);
    } else if (tok.startsWith("[")) {
      const close = tok.indexOf("](");
      const label = tok.slice(1, close);
      const href = tok.slice(close + 2, -1);
      // Only http(s) — a javascript: or data: href is not a link we render.
      out.push(/^https?:\/\//i.test(href)
        ? <a key={k} href={href} target="_blank" rel="noreferrer noopener">{label}</a>
        : <span key={k}>{label}</span>);
    } else {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface ListItem { indent: number; ordered: boolean; text: string }

function renderList(items: ListItem[], key: string, opts: Opts = {}): React.ReactNode {
  // Group by indent, recursing on deeper runs so sub-bullets nest instead of
  // flattening — models indent heavily and a flat list loses the structure.
  const base = items[0].indent;
  const Tag = items[0].ordered ? "ol" : "ul";
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].indent > base) continue;             // consumed below
    const deeper: ListItem[] = [];
    let j = i + 1;
    while (j < items.length && items[j].indent > base) { deeper.push(items[j]); j++; }
    nodes.push(
      <li key={`${key}-li${i}`}>
        {inline(items[i].text, `${key}-li${i}`, opts)}
        {deeper.length > 0 && renderList(deeper, `${key}-li${i}-n`, opts)}
      </li>);
    i = j - 1;
  }
  return <Tag key={key} className="md-list">{nodes}</Tag>;
}

export function Markdown({ text, asset }: { text: string; asset?: AssetRenderer }) {
  const opts: Opts = { asset };
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let para: string[] = [];
  let list: ListItem[] = [];
  let quote: string[] = [];
  let n = 0;

  const flushPara = () => {
    if (!para.length) return;
    out.push(<p key={`p${n++}`} className="md-p">{inline(para.join(" "), `p${n}`, opts)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    out.push(renderList(list, `l${n++}`, opts));
    list = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(<blockquote key={`q${n++}`} className="md-quote">{inline(quote.join(" "), `q${n}`, opts)}</blockquote>);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    const fence = raw.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushAll();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      out.push(
        <pre key={`c${n++}`} className="md-pre ns-scroll">
          <code>{body.join("\n")}</code>
        </pre>);
      continue;
    }

    if (!raw.trim()) { flushAll(); continue; }

    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(4, heading[1].length);   // h5/h6 add nothing here
      out.push(
        <div key={`h${n++}`} className={`md-h md-h${level}`}>
          {inline(heading[2], `h${n}`, opts)}
        </div>);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {   // --- rule
      flushAll();
      out.push(<hr key={`r${n++}`} className="md-hr" />);
      continue;
    }

    const bullet = raw.match(/^(\s*)[-*•]\s+(.*)$/);
    const numbered = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara(); flushQuote();
      const indentText = (bullet ?? numbered)![1];
      list.push({
        // Tabs and 2- or 4-space indents all mean "one level in".
        indent: Math.floor(indentText.replace(/\t/g, "  ").length / 2),
        ordered: !!numbered,
        text: (bullet ? bullet[2] : numbered![3]).trim(),
      });
      continue;
    }

    const q = raw.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }

    flushList(); flushQuote();
    para.push(raw.trim());
  }
  flushAll();

  return <div className="md">{out}</div>;
}
