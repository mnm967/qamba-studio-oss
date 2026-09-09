// The preview player is mounted once at the shell level so playback survives
// navigation. When the timeline view is on screen it has to *look* like it
// lives inside the stage — but reparenting a <video> in the DOM reloads it and
// kills playback, which is the whole thing we're avoiding. So the stage
// renders an empty box and publishes it here; the shell-level player reads
// that box's rect and positions itself over it. One DOM node, two positions.
let el: HTMLElement | null = null;
const subs = new Set<(el: HTMLElement | null) => void>();

export function setStageAnchor(next: HTMLElement | null) {
  if (el === next) return;
  el = next;
  subs.forEach((f) => f(next));
}

export function subscribeStageAnchor(f: (el: HTMLElement | null) => void) {
  subs.add(f);
  f(el);
  return () => { subs.delete(f); };
}
