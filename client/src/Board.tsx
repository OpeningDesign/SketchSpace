import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import { BonsaiPanel } from "./BonsaiPanel";
import { getSocket } from "./socket";
import { TabStrip } from "./TabStrip";
import { useCollab } from "./useCollab";
import { useViewLink } from "./useViewLink";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const answers = () =>
  fetch("/api/session", { cache: "no-store" }).then(
    (r) => r.ok,
    () => false,
  );

/**
 * Wait for a restarted server to come back, then reload.
 *
 * The old server is still answering for a moment after it agrees to restart,
 * so first wait for it to go, then for the new one - reloading on the old one's
 * last answer would load a page from a server about to disappear. Reloading
 * rather than reconnecting also picks up a rebuilt client, which is usually
 * why the server was restarted.
 */
const reloadWhenBack = async (): Promise<boolean> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && (await answers())) {
    await sleep(300);
  }
  while (Date.now() < deadline) {
    if (await answers()) {
      window.location.reload();
      return true;
    }
    await sleep(1000);
  }
  return false;
};

type Props = {
  boardId: string;
  /** Deep-linked sheet, e.g. from Bonsai's "open layout" button. */
  initialPageId?: string | null;
  onExit: () => void;
};

export const Board = ({ boardId, initialPageId, onExit }: Props) => {
  const collab = useCollab(boardId, initialPageId ?? null);

  // Keeps the address bar pointing at the sheet and region on screen, so a link
  // shares the view rather than just the drawing.
  const { onViewChange } = useViewLink(
    collab.excalidrawAPI,
    boardId,
    collab.activePageId,
  );

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

  // The layout is written back automatically when a placement settles; this is
  // just so the change is visible rather than silent.
  const [savedAt, setSavedAt] = useState<{ total: number; at: number } | null>(
    null,
  );

  useEffect(() => {
    const socket = getSocket();
    const onPushed = (p: { boardId: string; total: number; at: number }) => {
      if (p.boardId === boardId) {
        setSavedAt({ total: p.total, at: p.at });
      }
    };
    socket.on("layout:pushed", onPushed);
    return () => {
      socket.off("layout:pushed", onPushed);
    };
  }, [boardId]);

  useEffect(() => {
    if (!savedAt) {
      return;
    }
    const t = setTimeout(() => setSavedAt(null), 4000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Stopping or restarting the server is for everyone on it, so it is confirmed,
  // and then the whole board is covered: nothing typed now would be kept.
  const [serverState, setServerState] = useState<
    "stopping" | "stopped" | "restarting" | "lost" | null
  >(null);

  const stopServer = async () => {
    if (!window.confirm("Stop SketchSpace for everyone using it? Work so far is saved first.")) {
      return;
    }
    setServerState("stopping");
    try {
      await api.stopServer();
      setServerState("stopped");
    } catch (error) {
      setServerState(null);
      window.alert((error as Error).message);
    }
  };

  const restartServer = async () => {
    if (!window.confirm("Restart SketchSpace for everyone using it? Work so far is saved first.")) {
      return;
    }
    setServerState("restarting");
    try {
      await api.restartServer();
    } catch (error) {
      setServerState(null);
      window.alert((error as Error).message);
      return;
    }
    if (!(await reloadWhenBack())) {
      setServerState("lost");
    }
  };

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
        {/*
          Sits in the canvas layer rather than the header, tucked to the left of
          Excalidraw's help button, so the layout write is visible where the
          drawing is without taking up chrome.
        */}
        <BonsaiPanel excalidrawAPI={collab.excalidrawAPI as never} />

        {hasBonsaiPlacements && (
          <span
            className="board__sync"
            title="Drawing positions are written back to the Bonsai layout automatically"
          >
            {savedAt
              ? `layout saved — ${savedAt.total} placement${savedAt.total === 1 ? "" : "s"}`
              : "layout linked"}
          </span>
        )}

        <Excalidraw
          // Renamed from `excalidrawAPI` upstream in #10870, after the 0.18.1
          // npm release. We track the local checkout, so we use the new name.
          onExcalidrawAPI={collab.setExcalidrawAPI}
          onChange={collab.onChange}
          onPointerUpdate={collab.onPointerUpdate}
          onScrollChange={onViewChange}
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
            <MainMenu.Separator />
            <MainMenu.Item onSelect={() => void restartServer()}>
              Restart SketchSpace
            </MainMenu.Item>
            <MainMenu.Item onSelect={() => void stopServer()}>
              Stop SketchSpace
            </MainMenu.Item>
          </MainMenu>
        </Excalidraw>
      </div>

      {serverState && (
        <div className="serverstate" role="status">
          <div className="serverstate__card">
            {serverState === "stopping" && <p>Stopping SketchSpace…</p>}
            {serverState === "restarting" && (
              <p>Restarting SketchSpace… this page reloads when it is back, usually within 20 seconds.</p>
            )}
            {serverState === "stopped" && (
              <>
                <p>
                  <strong>SketchSpace is stopped.</strong>
                </p>
                <p>
                  Open a layout from Blender to start it again, or run <code>npm start</code>.
                </p>
              </>
            )}
            {serverState === "lost" && (
              <>
                <p>
                  <strong>SketchSpace did not come back.</strong>
                </p>
                <p>
                  Its output is in <code>server.log</code> in the data directory. Opening a layout
                  from Blender starts it again.
                </p>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
};
