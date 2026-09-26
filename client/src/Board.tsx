import {
  Excalidraw,
  MainMenu,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AddDrawing } from "./AddDrawing";
import { api, type BonsaiDrawing } from "./api";
import { BonsaiPanel } from "./BonsaiPanel";
import { getSocket } from "./socket";
import { TabStrip } from "./TabStrip";
import { useCollab } from "./useCollab";
import { useViewLink } from "./useViewLink";

/**
 * Menu icons, drawn to match the editor's own rather than imported from them -
 * `components/icons` is internal to the package and not exported.
 *
 * All three share the editor's geometry: a 24 box, stroked in `currentColor`
 * at 1.5, round caps and joins, so they sit with the built-in items rather
 * than beside them.
 */
const menuIcon = (children: ReactNode) => (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

/** A sheet with a plus on it. */
const addDrawingIcon = (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5" />
    <path d="M8.5 9.5h6M8.5 13h6M8.5 16.5h3.5" />
    <path d="M18 3v5M15.5 5.5h5" />
  </svg>
);

/** An arrow coming back round to where it started. */
const restartIcon = menuIcon(
  <>
    <path d="M20 13a8 8 0 1 1-2.3-6.3" />
    <path d="M20.5 4v5h-5" />
  </>,
);

/** The usual power symbol: this leaves it off until something starts it again. */
const stopIcon = menuIcon(
  <>
    <path d="M17.6 7.4a8 8 0 1 1-11.2 0" />
    <path d="M12 3v8" />
  </>,
);

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
  const layoutPath = useMemo(() => {
    const els = collab.excalidrawAPI?.getSceneElements() ?? [];
    for (const el of els) {
      const layout = (el.customData as { bonsai?: { layout?: string } } | undefined)
        ?.bonsai?.layout;
      if (layout) {
        return layout;
      }
    }
    return null;
  }, [collab.excalidrawAPI, collab.activePageId]);
  const hasBonsaiPlacements = layoutPath !== null;

  /* --------------------------- adding a drawing --------------------------- */

  // Two steps: pick one, then click where it goes. The click is what the
  // position comes from, so the dialog closes before it is asked for.
  const [picking, setPicking] = useState(false);
  const [placing, setPlacing] = useState<BonsaiDrawing | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  // Where to draw the prompt: beside the pointer, since the pointer is what is
  // being aimed. Null until the mouse has moved, so it never appears somewhere
  // the pointer is not.
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  /** CSS reference pixels per millimetre, as the layout importer uses. */
  const MM_TO_PX = 96 / 25.4;

  const place = useCallback(
    async (event: MouseEvent) => {
      const api_ = collab.excalidrawAPI;
      if (!placing || !layoutPath || !api_) {
        return;
      }
      // Ours, not the editor's: a click in placing mode places, and must not
      // also land on the canvas as a selection.
      event.preventDefault();
      event.stopPropagation();

      const scene = viewportCoordsToSceneCoords(
        { clientX: event.clientX, clientY: event.clientY },
        api_.getAppState(),
      );
      const drawing = placing;
      setPlacing(null);
      try {
        await api.placeBonsaiDrawing(
          layoutPath,
          drawing.globalId,
          scene.x / MM_TO_PX,
          scene.y / MM_TO_PX,
        );
        setPlaced(`added ${drawing.name}`);
      } catch (error) {
        setPlaced((error as Error).message);
      }
    },
    [collab.excalidrawAPI, layoutPath, placing, MM_TO_PX],
  );

  useEffect(() => {
    const node = canvas.current;
    if (!placing || !node) {
      setPointer(null);
      return;
    }
    const cancel = (e: KeyboardEvent) => e.key === "Escape" && setPlacing(null);
    const follow = (e: MouseEvent) => {
      const box = node.getBoundingClientRect();
      setPointer({ x: e.clientX - box.left, y: e.clientY - box.top });
    };
    node.addEventListener("click", place, true);
    node.addEventListener("mousemove", follow);
    node.addEventListener("mouseleave", () => setPointer(null));
    window.addEventListener("keydown", cancel);
    return () => {
      node.removeEventListener("click", place, true);
      node.removeEventListener("mousemove", follow);
      window.removeEventListener("keydown", cancel);
    };
  }, [placing, place]);

  useEffect(() => {
    if (!placed) {
      return;
    }
    const t = setTimeout(() => setPlaced(null), 4000);
    return () => clearTimeout(t);
  }, [placed]);

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

      <div className="board__canvas" ref={canvas}>
        {picking && layoutPath && (
          <AddDrawing
            layout={layoutPath}
            onClose={() => setPicking(false)}
            onPick={(drawing) => {
              setPicking(false);
              setPlacing(drawing);
            }}
          />
        )}

        {placing && pointer && (
          <div
            className="board__placing board__placing--cursor"
            style={{ left: pointer.x, top: pointer.y }}
          >
            Click where <strong>{placing.name}</strong> should go — Esc to cancel
          </div>
        )}
        {placed && <div className="board__placing">{placed}</div>}

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
            {/*
              Bonsai places the drawing and the sheet updates itself, so this
              belongs with the sheet rather than with the editor's own tools.
              Only on a page that is a Bonsai sheet: there is nowhere to put a
              drawing otherwise.
            */}
            {hasBonsaiPlacements && (
              <>
                <MainMenu.Separator />
                <MainMenu.Item icon={addDrawingIcon} onSelect={() => setPicking(true)}>
                  Add drawing…
                </MainMenu.Item>
              </>
            )}
            <MainMenu.Separator />
            <MainMenu.Item icon={restartIcon} onSelect={() => void restartServer()}>
              Restart SketchSpace
            </MainMenu.Item>
            <MainMenu.Item icon={stopIcon} onSelect={() => void stopServer()}>
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
