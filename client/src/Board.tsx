import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import { useEffect, useMemo, useState } from "react";

import { PushDialog } from "./PushDialog";
import { getSocket } from "./socket";
import { TabStrip } from "./TabStrip";
import { useCollab } from "./useCollab";

type Props = {
  boardId: string;
  onExit: () => void;
};

export const Board = ({ boardId, onExit }: Props) => {
  const collab = useCollab(boardId);

  // Let other people see a name rather than "Guest a1b2".
  useEffect(() => {
    const name = localStorage.getItem("sketchspace:username");
    if (name) {
      getSocket().emit("user:name", name);
    }
    // Leaving the board is not the same as disconnecting the socket.
    return () => {
      getSocket().emit("board:leave");
    };
  }, []);

  const [pushOpen, setPushOpen] = useState(false);

  const others = collab.users.filter(
    (u) => u.socketId !== getSocket().id,
  );

  // Only offer the Bonsai push when this board actually came from a layout.
  const hasBonsaiPlacements = useMemo(() => {
    const els = collab.excalidrawAPI?.getSceneElements() ?? [];
    return els.some(
      (el) =>
        (el.customData as { bonsai?: { layout?: string } } | undefined)?.bonsai
          ?.layout,
    );
  }, [collab.excalidrawAPI, collab.activePageId]);

  return (
    <div className="board">
      <header className="board__bar">
        <button className="linkish" onClick={onExit} title="All boards">
          ‹ Boards
        </button>
        <span className="board__name">{collab.board?.name ?? "…"}</span>

        {hasBonsaiPlacements && (
          <button
            className="board__push"
            onClick={() => setPushOpen(true)}
            title="Write moved drawings back into the Bonsai layout"
          >
            Push to Bonsai
          </button>
        )}

        <div className="board__users">
          {others.map((u) => (
            <span
              key={u.socketId}
              className="avatar"
              style={{ background: u.color }}
              title={`${u.username}${
                u.pageId === collab.activePageId ? " (this page)" : ""
              }`}
            >
              {u.username.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
      </header>

      {collab.error && <div className="board__error">{collab.error}</div>}

      <TabStrip
        pages={collab.pages}
        activePageId={collab.activePageId}
        users={collab.users}
        onOpen={(id) => void collab.openPage(id)}
        onCreate={() => void collab.createPage()}
        onRename={collab.renamePage}
        onDelete={collab.deletePage}
        onMove={collab.movePage}
      />

      <div className="board__canvas">
        <Excalidraw
          // Renamed from `excalidrawAPI` upstream in #10870, after the 0.18.1
          // npm release. We track the local checkout, so we use the new name.
          onExcalidrawAPI={collab.setExcalidrawAPI}
          onChange={collab.onChange}
          onPointerUpdate={collab.onPointerUpdate}
          isCollaborating
          UIOptions={{ canvasActions: { loadScene: false } }}
        >
          {/*
            The editor's built-in fallback menu (LayerUI's DefaultMainMenu)
            omits Preferences entirely, so without supplying our own menu there
            is nowhere to reach the preference items - including the wheel
            behaviour toggle. Scene load/save entries are left out: a page lives
            on the server, not in a local file.
          */}
          <MainMenu>
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.CommandPalette className="highlighted" />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.Preferences />
            {/* `allowSystemTheme` needs the host to own theme state; we don't. */}
            <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>

      {pushOpen && (
        <PushDialog boardId={boardId} onClose={() => setPushOpen(false)} />
      )}
    </div>
  );
};
