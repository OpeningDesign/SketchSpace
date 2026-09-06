import { useEffect, useState } from "react";

import { api } from "./api";

import type { Board } from "./types";

type Props = {
  onOpen: (boardId: string) => void;
  onLogout: () => void;
};

export const BoardList = ({ onOpen, onLogout }: Props) => {
  const [boards, setBoards] = useState<Board[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api
      .listBoards()
      .then((r) => setBoards(r.boards))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    void refresh();
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { board } = await api.createBoard(name || "Untitled board");
      setName("");
      onOpen(board.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (board: Board) => {
    if (!confirm(`Delete "${board.name}" and all of its pages?`)) {
      return;
    }
    await api.deleteBoard(board.id);
    void refresh();
  };

  return (
    <div className="shell">
      <div className="panel panel--wide">
        <header className="panel__head">
          <h1>Boards</h1>
          <button className="linkish" onClick={onLogout}>
            Log out
          </button>
        </header>

        <form className="row" onSubmit={create}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New board name"
          />
          <button type="submit">Create</button>
        </form>

        {error && <p className="error">{error}</p>}
        {loading && <p className="muted">Loading…</p>}
        {!loading && boards.length === 0 && (
          <p className="muted">No boards yet. Create one above.</p>
        )}

        <ul className="boards">
          {boards.map((board) => (
            <li key={board.id}>
              <button className="boards__open" onClick={() => onOpen(board.id)}>
                <span className="boards__name">{board.name}</span>
                <span className="muted">
                  {new Date(board.updatedAt).toLocaleString()}
                </span>
              </button>
              <button
                className="boards__delete"
                title="Delete board"
                onClick={() => void remove(board)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
