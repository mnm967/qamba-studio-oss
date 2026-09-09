// node --test src/lib/titlebar.test.ts
//
// The traffic-light gutter. Both ways of getting this wrong are visual and
// neither throws: too little and the NS mark renders under the minimise button
// (the bug), too much and the WEB build gets a mystery 78px hole to the left of
// its wordmark on every machine — the same rule, applied where no window
// controls exist.
//
// Only the decision is tested here, not the CSS: the surfaces read the
// variable through `max()`, so a wrong number is visible and a wrong PLATFORM
// is not.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INSET_VAR, TRAFFIC_LIGHT_INSET_PX, applyTitlebarInset, isMacUA, titlebarInset,
} from "./titlebar.ts";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

test("the gutter exists only in a macOS desktop window", () => {
  assert.equal(titlebarInset({ desktop: true, mac: true }), TRAFFIC_LIGHT_INSET_PX);
  // The web build has no overlay at all — this is the regression that would
  // ship an indent to every browser.
  assert.equal(titlebarInset({ desktop: false, mac: true }), 0);
  // Windows and Linux draw their controls on the RIGHT, where no chrome starts.
  assert.equal(titlebarInset({ desktop: true, mac: false }), 0);
});

test("fullscreen takes the gutter back", () => {
  // macOS hides the buttons in fullscreen, so holding the space would leave a
  // permanent hole rather than reserving anything.
  assert.equal(titlebarInset({ desktop: true, mac: true, fullscreen: true }), 0);
  assert.equal(titlebarInset({ desktop: true, mac: true, fullscreen: false }),
    TRAFFIC_LIGHT_INSET_PX);
});

test("the inset clears the zoom button", () => {
  // 12pt buttons on 20pt centres from x=20 put the zoom button's right edge at
  // 66. Anything at or below that is still an overlap, just a smaller one.
  assert.ok(TRAFFIC_LIGHT_INSET_PX > 66);
});

test("macOS is recognised from either signal", () => {
  assert.equal(isMacUA({ platform: "MacIntel", userAgent: WIN_UA }), true);
  assert.equal(isMacUA({ platform: "", userAgent: MAC_UA }), true);
  assert.equal(isMacUA({ platform: "Win32", userAgent: WIN_UA }), false);
  // A missing navigator must read as "not mac", never throw: the value it
  // guards is an indent, and an exception here is in the startup path.
  assert.equal(isMacUA({}), false);
});

test("applying zero leaves no trace behind", () => {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = {
    style: { setProperty: (k: string, v: string) => void props.set(k, v) },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  } as unknown as HTMLElement;

  applyTitlebarInset(TRAFFIC_LIGHT_INSET_PX, root);
  assert.equal(props.get(INSET_VAR), "78px");
  assert.equal(attrs.get("data-titlebar"), "overlay");

  // Leaving fullscreen re-applies 0, and the marker has to go with it — a
  // stale attribute is what a rule keyed on it would still be honouring.
  applyTitlebarInset(0, root);
  assert.equal(props.get(INSET_VAR), "0px");
  assert.equal(attrs.has("data-titlebar"), false);
});
