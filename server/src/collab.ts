import { isAuthed } from "./auth.js";
import {
  createPage,
  deletePage,
  getBoard,
  getPage,
  listPages,
  movePage,
  renamePage,
  touchBoard,
} from "./db.js";
import { scheduleLayoutAutosave } from "./layoutWriter.js";
import { addViewer, applyUpdate, getElements, removeViewer } from "./store.js";

import type { Presence, SyncElement } from "./types.js";
import type { Server, Socket } from "socket.io";

/**
 * Room topology
 * -------------
 *   board:{boardId}  every viewer of the board joins this and stays.
 *                    Carries the page list and document-wide presence.
 *   page:{pageId}    joined and left as you switch pages.
 *                    Carries scene updates and pointers.
 *
 * The split is what keeps this cheap: someone editing page 1 never receives a
 * single packet of page 7's traffic, but still shows up in the presence list
 * and still sees pages being added and renamed.
 */
export const boardRoom = (boardId: string) => `board:${boardId}`;
export const pageRoom = (pageId: string) => `page:${pageId}`;

const COLORS = [
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#9c36b5",
  "#0c8599",
  "#e8590c",
  "#5f3dc4",
];

const presences = new Map<string, Presence>();

const colorFor = (socketId: string): string => {
  let hash = 0;
  for (let i = 0; i < socketId.length; i++) {
    hash = (hash * 31 + socketId.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length]!;
};

const broadcastPresence = (io: Server, boardId: string): void => {
  const users = [...presences.values()].filter((p) => p.boardId === boardId);
  io.to(boardRoom(boardId)).emit("presence", { boardId, users });
};

const broadcastPages = (io: Server, boardId: string): void => {
  io.to(boardRoom(boardId)).emit("pages:update", {
    boardId,
    pages: listPages(boardId),
  });
};

/** Detaches a socket from whichever page it currently has open. */
const leaveCurrentPage = (socket: Socket, presence: Presence): void => {
  if (!presence.pageId) {
    return;
  }
  socket.leave(pageRoom(presence.pageId));
  removeViewer(presence.pageId);
  presence.pageId = null;
};

type Ack<T> = (response: T) => void;

export const registerCollab = (io: Server): void => {
  io.use((socket, next) => {
    if (!isAuthed(socket.request as { headers: { cookie?: string } })) {
      next(new Error("unauthorized"));
      return;
    }
    next();
  });

  io.on("connection", (socket) => {
    const presence: Presence = {
      socketId: socket.id,
      username: `Guest ${socket.id.slice(0, 4)}`,
      color: colorFor(socket.id),
      boardId: null,
      pageId: null,
    };
    presences.set(socket.id, presence);

    socket.on("user:name", (username: unknown) => {
      if (typeof username === "string" && username.trim()) {
        presence.username = username.trim().slice(0, 40);
        if (presence.boardId) {
          broadcastPresence(io, presence.boardId);
        }
      }
    });

    socket.on(
      "board:join",
      (boardId: unknown, ack?: Ack<Record<string, unknown>>) => {
        if (typeof boardId !== "string") {
          ack?.({ error: "bad request" });
          return;
        }
        const board = getBoard(boardId);
        if (!board) {
          ack?.({ error: "not found" });
          return;
        }

        if (presence.boardId && presence.boardId !== boardId) {
          const previous = presence.boardId;
          leaveCurrentPage(socket, presence);
          socket.leave(boardRoom(previous));
          presence.boardId = null;
          broadcastPresence(io, previous);
        }

        presence.boardId = boardId;
        socket.join(boardRoom(boardId));

        const pages = listPages(boardId);
        ack?.({ board, pages });
        broadcastPresence(io, boardId);
      },
    );

    socket.on(
      "page:open",
      (pageId: unknown, ack?: Ack<Record<string, unknown>>) => {
        if (typeof pageId !== "string") {
          ack?.({ error: "bad request" });
          return;
        }
        const page = getPage(pageId);
        if (!page || page.boardId !== presence.boardId) {
          ack?.({ error: "not found" });
          return;
        }

        leaveCurrentPage(socket, presence);

        presence.pageId = pageId;
        socket.join(pageRoom(pageId));
        addViewer(pageId);

        ack?.({ pageId, elements: getElements(pageId) });
        if (presence.boardId) {
          broadcastPresence(io, presence.boardId);
        }
      },
    );

    socket.on(
      "scene:push",
      (payload: { pageId?: unknown; elements?: unknown }) => {
        const { pageId, elements } = payload ?? {};
        if (typeof pageId !== "string" || !Array.isArray(elements)) {
          return;
        }
        // A client may only write to the page it currently has open.
        if (presence.pageId !== pageId) {
          return;
        }

        const accepted = applyUpdate(pageId, elements as SyncElement[]);
        if (accepted.length === 0) {
          return;
        }

        // Only the other viewers of this page need the delta; the sender
        // already has it locally.
        socket.to(pageRoom(pageId)).emit("scene:patch", {
          pageId,
          elements: accepted,
        });

        if (presence.boardId) {
          touchBoard(presence.boardId);

          // Moving an imported Bonsai placement is an edit to the layout, not
          // just to the canvas. Write it back on a debounce so the layout stays
          // the source of truth without anyone pressing a button. Redlines carry
          // no `bonsai` metadata and never trigger this.
          const touchesLayout = accepted.some(
            (el) =>
              (el.customData as { bonsai?: { layout?: string } } | undefined)
                ?.bonsai?.layout,
          );
          if (touchesLayout) {
            const boardId = presence.boardId;
            scheduleLayoutAutosave(boardId, (result) => {
              // Baselines moved with the write; push them to open clients so
              // their copies agree with the layout on disk.
              for (const { pageId, elements } of result.refreshed) {
                io.to(pageRoom(pageId)).emit("scene:patch", { pageId, elements });
              }
              io.to(boardRoom(boardId)).emit("layout:pushed", {
                boardId,
                total: result.total,
                at: Date.now(),
              });
            });
          }
        }
      },
    );

    socket.on("pointer", (payload: Record<string, unknown>) => {
      const pageId = payload?.pageId;
      if (typeof pageId !== "string" || presence.pageId !== pageId) {
        return;
      }
      // Volatile by nature - a dropped cursor frame is worth nothing.
      socket.to(pageRoom(pageId)).volatile.emit("pointer", {
        ...payload,
        socketId: socket.id,
        username: presence.username,
        color: presence.color,
      });
    });

    socket.on(
      "page:create",
      (
        payload: { boardId?: unknown; name?: unknown; afterPageId?: unknown },
        ack?: Ack<Record<string, unknown>>,
      ) => {
        const { boardId, name, afterPageId } = payload ?? {};
        if (typeof boardId !== "string" || boardId !== presence.boardId) {
          ack?.({ error: "bad request" });
          return;
        }
        const page = createPage(
          boardId,
          typeof name === "string" ? name : null,
          typeof afterPageId === "string" ? afterPageId : null,
        );
        broadcastPages(io, boardId);
        ack?.({ page });
      },
    );

    socket.on(
      "page:rename",
      (payload: { pageId?: unknown; name?: unknown }) => {
        const { pageId, name } = payload ?? {};
        if (typeof pageId !== "string" || typeof name !== "string") {
          return;
        }
        const page = getPage(pageId);
        if (!page || page.boardId !== presence.boardId) {
          return;
        }
        renamePage(pageId, name.trim().slice(0, 80) || page.name);
        broadcastPages(io, page.boardId);
      },
    );

    socket.on("page:delete", (payload: { pageId?: unknown }) => {
      const pageId = payload?.pageId;
      if (typeof pageId !== "string") {
        return;
      }
      const page = getPage(pageId);
      if (!page || page.boardId !== presence.boardId) {
        return;
      }
      // Never leave a board with nothing in it.
      if (listPages(page.boardId).length <= 1) {
        return;
      }
      deletePage(pageId);
      broadcastPages(io, page.boardId);
    });

    socket.on(
      "page:move",
      (payload: {
        pageId?: unknown;
        afterPageId?: unknown;
        beforePageId?: unknown;
      }) => {
        const { pageId, afterPageId, beforePageId } = payload ?? {};
        if (typeof pageId !== "string") {
          return;
        }
        const page = getPage(pageId);
        if (!page || page.boardId !== presence.boardId) {
          return;
        }
        movePage(
          pageId,
          typeof afterPageId === "string" ? afterPageId : null,
          typeof beforePageId === "string" ? beforePageId : null,
        );
        broadcastPages(io, page.boardId);
      },
    );

    /**
     * Navigating back to the board list is not a disconnect. Without this the
     * user lingers in the presence list and their page stays pinned in the
     * server's cache.
     */
    socket.on("board:leave", () => {
      const boardId = presence.boardId;
      if (!boardId) {
        return;
      }
      leaveCurrentPage(socket, presence);
      socket.leave(boardRoom(boardId));
      presence.boardId = null;
      broadcastPresence(io, boardId);
    });

    socket.on("disconnect", () => {
      const boardId = presence.boardId;
      leaveCurrentPage(socket, presence);
      presences.delete(socket.id);
      if (boardId) {
        broadcastPresence(io, boardId);
      }
    });
  });
};
