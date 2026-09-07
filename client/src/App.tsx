import { useEffect, useState } from "react";

import { api } from "./api";
import { Board } from "./Board";
import { BoardList } from "./BoardList";
import { Login } from "./Login";
import { disconnectSocket } from "./socket";

/**
 * Hash routing: `#/board/<id>` or `#/board/<id>/<pageId>`, empty means the board
 * list. The optional page lets something outside the app deep-link to a specific
 * sheet - `scripts/open-layout.mjs` uses it so Bonsai's "open layout" button can
 * land on the right tab.
 */
const readRoute = (): { boardId: string; pageId: string | null } | null => {
  const match = /^#\/board\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(
    window.location.hash,
  );
  return match ? { boardId: match[1]!, pageId: match[2] ?? null } : null;
};

export const App = () => {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [route, setRoute] = useState<ReturnType<typeof readRoute>>(readRoute);

  useEffect(() => {
    api
      .session()
      .then((r) => setAuthed(r.authed))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openBoard = (id: string) => {
    window.location.hash = `#/board/${id}`;
    setRoute({ boardId: id, pageId: null });
  };

  const exitBoard = () => {
    window.location.hash = "";
    setRoute(null);
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

  if (route) {
    return (
      <Board
        key={route.boardId}
        boardId={route.boardId}
        initialPageId={route.pageId}
        onExit={exitBoard}
      />
    );
  }

  return <BoardList onOpen={openBoard} onLogout={logout} />;
};
