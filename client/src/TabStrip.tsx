import { useEffect, useRef, useState } from "react";

import type { Page, PresenceUser } from "./types";

type Props = {
  pages: Page[];
  activePageId: string | null;
  users: PresenceUser[];
  onOpen: (pageId: string) => void;
  onCreate: () => void;
  onRename: (pageId: string, name: string) => void;
  onDelete: (pageId: string) => void;
  onMove: (
    pageId: string,
    afterPageId: string | null,
    beforePageId: string | null,
  ) => void;
};

export const TabStrip = ({
  pages,
  activePageId,
  users,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onMove,
}: Props) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) {
      inputRef.current?.select();
    }
  }, [editingId]);

  const beginRename = (page: Page) => {
    setEditingId(page.id);
    setDraft(page.name);
  };

  const commitRename = () => {
    if (editingId && draft.trim()) {
      onRename(editingId, draft.trim());
    }
    setEditingId(null);
  };

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      return;
    }
    const from = pages.findIndex((p) => p.id === dragId);
    const to = pages.findIndex((p) => p.id === targetId);
    if (from === -1 || to === -1) {
      setDragId(null);
      return;
    }

    // Dropping onto a tab means "take its place": land between the target and
    // whichever neighbour we are arriving from.
    const after = from < to ? pages[to] : pages[to - 1];
    const before = from < to ? pages[to + 1] : pages[to];

    onMove(
      dragId,
      after && after.id !== dragId ? after.id : null,
      before && before.id !== dragId ? before.id : null,
    );
    setDragId(null);
  };

  return (
    <div className="tabstrip">
      <div className="tabstrip__tabs">
        {pages.map((page) => {
          const viewers = users.filter((u) => u.pageId === page.id);
          const isActive = page.id === activePageId;

          return (
            <div
              key={page.id}
              className={`tab${isActive ? " tab--active" : ""}${
                dragId === page.id ? " tab--dragging" : ""
              }`}
              draggable={editingId !== page.id}
              onDragStart={() => setDragId(page.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(page.id)}
              onDragEnd={() => setDragId(null)}
              onClick={() => !isActive && onOpen(page.id)}
              onDoubleClick={() => beginRename(page)}
              title={page.name}
            >
              {editingId === page.id ? (
                <input
                  ref={inputRef}
                  className="tab__input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      commitRename();
                    }
                    if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="tab__name">{page.name}</span>
                  {viewers.length > 0 && (
                    <span className="tab__viewers">
                      {viewers.slice(0, 3).map((u) => (
                        <span
                          key={u.socketId}
                          className="tab__dot"
                          style={{ background: u.color }}
                          title={u.username}
                        />
                      ))}
                    </span>
                  )}
                  {pages.length > 1 && (
                    <button
                      className="tab__close"
                      title="Delete page"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${page.name}"?`)) {
                          onDelete(page.id);
                        }
                      }}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}

        <button className="tab__add" onClick={onCreate} title="New page">
          +
        </button>
      </div>
    </div>
  );
};
