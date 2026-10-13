import { useMemo, useState } from "react";
import type { Attachment, FileNode, Session } from "../lib/types";

function FileRow({
  node,
  depth,
  attached,
  onToggle,
  onPreview,
}: {
  node: FileNode;
  depth: number;
  attached: Set<string>;
  onToggle: (node: FileNode) => void;
  onPreview: (node: FileNode) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  if (node.type === "dir") {
    return (
      <div>
        <button
          type="button"
          className="tree-row"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tree-chevron">{open ? "▾" : "▸"}</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {open &&
          node.children?.map((c) => (
            <FileRow
              key={c.path}
              node={c}
              depth={depth + 1}
              attached={attached}
              onToggle={onToggle}
              onPreview={onPreview}
            />
          ))}
      </div>
    );
  }
  const on = attached.has(node.path);
  return (
    <div
      className={`tree-row file ${on ? "on" : ""}`}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <label className="tree-check">
        <input
          type="checkbox"
          checked={on}
          disabled={node.text === false}
          onChange={() => onToggle(node)}
        />
      </label>
      <button type="button" className="tree-name btn" onClick={() => onPreview(node)}>
        {node.name}
      </button>
    </div>
  );
}

export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  tree,
  attachments,
  onToggleFile,
  onPreviewFile,
  dragging,
}: {
  sessions: Session[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  tree: FileNode[];
  attachments: Attachment[];
  onToggleFile: (node: FileNode) => void;
  onPreviewFile: (node: FileNode) => void;
  /** a file is being dragged over the window */
  dragging: boolean;
}) {
  const [q, setQ] = useState("");
  const attached = useMemo(() => new Set(attachments.map((a) => a.path)), [attachments]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return sessions;
    return sessions.filter((x) => x.title.toLowerCase().includes(s));
  }, [sessions, q]);

  return (
    <aside className="rail left">
      <section className="rail-block">
        <header className="rail-head">
          <span>Sessions</span>
          <button type="button" className="icon-btn" onClick={onNew} title="New chat (⌘N)">
            new
          </button>
        </header>
        <input
          className="search"
          placeholder="Filter sessions"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="session-list">
          {filtered.length === 0 && <p className="muted pad">No sessions yet.</p>}
          {filtered.map((s) => (
            <div
              key={s.id}
              className={`session ${s.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="session-title">{s.title}</div>
              <div className="session-meta">
                {s.family}/{s.modeId} · {s.messages.length} msgs
              </div>
              <button
                type="button"
                className="ghost-x"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="rail-block grow">
        <header className="rail-head">
          <span>Workspace</span>
          <span className="muted tiny">{attached.size} pinned</span>
        </header>
        <div className={`dropzone ${dragging ? "over" : ""}`}>
          Drop files to pin as context
        </div>
        <div className="tree">
          {tree.length === 0 && (
            <p className="muted pad">No files. Drop some, or add them to ./workspace.</p>
          )}
          {tree.map((n) => (
            <FileRow
              key={n.path}
              node={n}
              depth={0}
              attached={attached}
              onToggle={onToggleFile}
              onPreview={onPreviewFile}
            />
          ))}
        </div>
      </section>
    </aside>
  );
}
