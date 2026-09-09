// Media in: every upload in the app — a dropped reference, a still, a finished
// render — funnels through the functions below, and every one of them lands
// in the open project's own media folder on this machine.
import { activeLocalProjectId, deleteLocalMedia, localKeyOwner, writeLocalMedia } from "./localPlane.ts";

function requireProject() {
  const id = activeLocalProjectId();
  if (!id) throw new Error("open a project first — media belongs to a project");
  return id;
}

// Still/reference upload. Downscales the image client-side (max 1280px, JPEG)
// so a reference sheet does not carry a 20MB camera original into every
// render that stages it.
function downscale(file, max = 1280, quality = 0.9) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      const dataUrl = c.toDataURL("image/jpeg", quality);
      resolve({ b64: dataUrl.split(",")[1], ct: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export async function uploadStill(file, key) {
  const project = requireProject();
  let payload = await downscale(file);
  if (!payload) {
    // fallback: send the raw file if it can't be drawn (e.g. non-image)
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    payload = { b64: btoa(s), ct: file.type || "application/octet-stream" };
  }
  // keep the key's extension consistent with the (possibly transcoded) type
  const finalKey = payload.ct === "image/jpeg" ? key.replace(/\.(png|webp|gif)$/i, ".jpg") : key;
  const bytes = Uint8Array.from(atob(payload.b64), (c) => c.charCodeAt(0));
  return writeLocalMedia(project, finalKey, new Blob([bytes], { type: payload.ct }));
}

// Arbitrary reference media (image / video / audio), as-is: a reference
// video's frames and soundtrack are the point, so nothing is re-encoded.
// `onProgress` gets 0..1 so the UI can show a bar for big files.
export function uploadMedia(file, key, onProgress) {
  return writeLocalMedia(requireProject(), key, file, onProgress);
}

// Remove media files (stills / take MP4s / dialogue audio) from disk.
export async function deleteMedia(keys) {
  const list = (keys || []).filter(Boolean);
  if (!list.length) return { deleted: [] };
  // Deletes are DB-ROW-FIRST: by the time this runs the `assets` row is
  // already gone, so a key can no longer be traced to the project that held
  // it through the row. A key still known to a local project goes there, and
  // otherwise the open project owns the whole call.
  const openLocal = activeLocalProjectId();
  const local = openLocal ? list : list.filter((k) => localKeyOwner(k));
  if (local.length) await deleteLocalMedia(local);
  return { deleted: local };
}
