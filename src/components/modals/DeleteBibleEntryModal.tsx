import React, { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import ModalShell from "./ModalShell";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { deleteBibleEntry } from "../../lib/db/director";

export default function DeleteBibleEntryModal({
  entryId,
  name,
  kindName = "entry",
  onClose,
  onDeleted,
}: {
  entryId: string;
  name: string;
  kindName?: string;
  onClose?: () => void;
  onDeleted?: () => void;
}) {
  const ws = useWorkspaceStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const close = onClose ?? ws.closeModal;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const handleDelete = async () => {
    setBusy(true);
    setErr(null);
    try {
      await deleteBibleEntry(entryId);
      onDeleted?.();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const isLore = kindName === "lore";
  const label = kindName ? kindName[0].toUpperCase() + kindName.slice(1) : "Entry";

  return (
    <ModalShell
      width={460}
      icon={<Trash2 size={16} style={{ color: "#ff6b6b" }} />}
      title={`Delete ${kindName || "entry"}`}
      context="Permanent action"
      onClose={close}
      footer={
        <>
          <button className="ws-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            className="ws-primary"
            style={{
              borderColor: "rgba(235, 87, 87, 0.6)",
              background: "rgba(235, 87, 87, 0.16)",
              color: "#ff6b6b",
            }}
            onClick={handleDelete}
            disabled={busy}
          >
            {busy ? <Loader2 size={14} className="ns-spin" /> : <Trash2 size={14} />} Delete {kindName || "entry"}
          </button>
        </>
      }
    >
      <div className="ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 20px" }}>
        <p style={{ fontSize: 13.5, color: "#c8cfdb", lineHeight: 1.6, margin: 0 }}>
          Are you sure you want to delete <b style={{ color: "#fff" }}>“{name}”</b> from the story bible?
          {isLore
            ? " All associated lore text and search embeddings will be permanently removed."
            : ` All attached reference sheets and slots for this ${kindName} will be permanently removed.`}
        </p>

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: "10px 12px",
            borderRadius: 12,
            background: "rgba(235, 87, 87, 0.08)",
            border: "1px solid rgba(235, 87, 87, 0.2)",
            color: "#ff8e8e",
            fontSize: 12.5,
          }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          <span>This action cannot be undone.</span>
        </div>

        {err && (
          <div
            style={{
              padding: "9px 12px",
              borderRadius: 10,
              background: "rgba(235, 87, 87, 0.15)",
              border: "1px solid rgba(235, 87, 87, 0.3)",
              color: "#ff8e8e",
              fontSize: 12,
            }}
          >
            {err}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
