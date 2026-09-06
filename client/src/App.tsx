import { useEffect, useState } from "react";

import { api } from "./api";
import { Board } from "./Board";
import { BoardList } from "./BoardList";
import { Login } from "./Login";
import { disconnectSocket } from "./socket";

/** Hash routing: #/board/<id>, empty means the board list. */
const readRoute = (): string | null => {
  const match = /^#\/board\/([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  return match?.[1] ?? null;
};

export const App = () => {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [boardId, setBoardId] = useState<string | null>(readRoute);

  useEffect(() => {
    api
      .session()
      .then((r) => setAuthed(r.authed))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const onHashChange = () => setBoardId(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openBoard = (id: string) => {
    window.location.hash = `#/board/${id}`;
    setBoardId(id);
  };

  const exitBoard = () => {
    window.location.hash = "";
    setBoardId(null);
  };

  const logout = async () => {
    await api.logout();
    disconnectSocket();
    setAuthed(false);
    exitBoard();
  };

  if (authed === null) {
    return <div className="shell" />;
  }

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />;
  }

  if (boardId) {
    return <Board boardId={boardId} onExit={exitBoard} />;
  }

  return <BoardList onOpen={openBoard} onLogout={logout} />;
};
