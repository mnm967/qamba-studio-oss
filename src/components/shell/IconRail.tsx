import React from "react";
import {
  Film, FolderOpen, Gauge, SlidersHorizontal, Users, Volume2,
} from "lucide-react";
import { useWorkspaceStore, type PanelKind } from "../../stores/useWorkspaceStore";

const PANELS: { id: PanelKind; title: string; icon: React.ReactNode }[] = [
  { id: "shots", title: "Shots", icon: <Film size={18} /> },
  { id: "refs", title: "Cast & references", icon: <Users size={18} /> },
  { id: "audio", title: "Audio & voice studio", icon: <Volume2 size={18} /> },
  { id: "queue", title: "Render queue & GPU", icon: <Gauge size={18} /> },
  { id: "models", title: "Project settings", icon: <SlidersHorizontal size={18} /> },
  { id: "library", title: "Quick media bin", icon: <FolderOpen size={18} /> },
];

export default function IconRail() {
  const ws = useWorkspaceStore();
  const pick = (id: PanelKind) => {
    if (ws.panel === id && ws.panelOpen) ws.toggle("panelOpen");
    else {
      ws.set("panel", id);
      if (!ws.panelOpen) ws.set("panelOpen", true);
    }
  };
  return (
    <nav className="ws-rail">
      {PANELS.map((p) => (
        <button key={p.id} title={p.title}
                className={ws.panel === p.id && ws.panelOpen ? "on" : ""}
                onClick={() => pick(p.id)}>
          {p.icon}
        </button>
      ))}
    </nav>
  );
}
