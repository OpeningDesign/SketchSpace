import { CaptureUpdateAction, reconcileElements } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";
import { getSocket, request } from "./socket";

import type { Board, Page, PresenceUser } from "./types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";

type AnyElement = OrderedExcalidrawElement & { fileId?: string };

const collectFileIds = (elements: readonly AnyElement[]): string[] => {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el.fileId) {
      ids.add(el.fileId);
    }
  }
  return [...ids];
};

const POINTER_INTERVAL_MS = 40;

export const useCollab = (boardId: string) => {
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * Last version we know the server has for each element - updated both when
   * we send and when we receive. Diffing against it is what stops us echoing
   * a remote change straight back to the server.
   */
  const syncedVersions = useRef(new Map<string, number>());
  const uploadedFiles = useRef(new Set<string>());
  const activePageIdRef = useRef<string | null>(null);
  const collaborators = useRef(new Map<SocketId, Collaborator>());
  const lastPointerSent = useRef(0);

  const setActive = (pageId: string | null) => {
    activePageIdRef.current = pageId;
    setActivePageId(pageId);
  };

  /** Pull down any images referenced by these elements that we don't have. */
  const ensureFiles = useCallback(
    async (elements: readonly AnyElement[]) => {
      if (!excalidrawAPI) {
        return;
      }
      const have = excalidrawAPI.getFiles();
      const missing = collectFileIds(elements).filter((id) => !have[id]);
      if (missing.length === 0) {
        return;
      }
      const { files } = await api.fetchFiles(boardId, missing);
      if (files.length > 0) {
        for (const file of files) {
          uploadedFiles.current.add(file.id);
        }
        excalidrawAPI.addFiles(files as unknown as BinaryFileData[]);
      }
    },
    [boardId, excalidrawAPI],
  );

  const openPage = useCallback(
    async (pageId: string) => {
      if (!excalidrawAPI) {
        return;
      }
      try {
        const { elements } = await request<{ elements: AnyElement[] }>(
          "page:open",
          pageId,
        );

        setActive(pageId);

        // Record what the server gave us before touching the scene, so the
        // onChange this triggers diffs to nothing.
        for (const el of elements) {
          syncedVersions.current.set(el.id, el.version);
        }

        excalidrawAPI.updateScene({
          elements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });

        void ensureFiles(elements);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [excalidrawAPI, ensureFiles],
  );

  /* ------------------------------ join board ----------------------------- */

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const result = await request<{ board: Board; pages: Page[] }>(
          "board:join",
          boardId,
        );
        if (cancelled) {
          return;
        }
        setBoard(result.board);
        setPages(result.pages);

        const remembered = localStorage.getItem(`sketchspace:page:${boardId}`);
        const target =
          result.pages.find((p) => p.id === remembered) ?? result.pages[0];
        if (target) {
          void openPage(target.id);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId, excalidrawAPI, openPage]);

  useEffect(() => {
    if (activePageId) {
      localStorage.setItem(`sketchspace:page:${boardId}`, activePageId);
    }
  }, [boardId, activePageId]);

  /* --------------------------- server -> client -------------------------- */

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const socket = getSocket();

    const onPatch = (payload: { pageId: string; elements: AnyElement[] }) => {
      if (payload.pageId !== activePageIdRef.current) {
        return;
      }

      const local = excalidrawAPI.getSceneElementsIncludingDeleted();
      const reconciled = reconcileElements(
        local,
        payload.elements as unknown as Parameters<typeof reconcileElements>[1],
        excalidrawAPI.getAppState(),
      );

      for (const el of payload.elements) {
        syncedVersions.current.set(el.id, el.version);
      }

      excalidrawAPI.updateScene({
        elements: reconciled,
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      void ensureFiles(payload.elements);
    };

    const onPages = (payload: { boardId: string; pages: Page[] }) => {
      if (payload.boardId !== boardId) {
        return;
      }
      setPages(payload.pages);

      // The page we were on may have been deleted by someone else.
      const current = activePageIdRef.current;
      if (current && !payload.pages.some((p) => p.id === current)) {
        const fallback = payload.pages[0];
        if (fallback) {
          void openPage(fallback.id);
        }
      }
    };

    const onPresence = (payload: {
      boardId: string;
      users: PresenceUser[];
    }) => {
      if (payload.boardId === boardId) {
        setUsers(payload.users);
      }
    };

    const onPointer = (payload: {
      pageId: string;
      socketId: SocketId;
      username: string;
      color: string;
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "up" | "down";
      selectedElementIds?: Readonly<{ [id: string]: true }>;
    }) => {
      if (payload.pageId !== activePageIdRef.current) {
        return;
      }
      const next = new Map(collaborators.current);
      next.set(payload.socketId, {
        socketId: payload.socketId,
        username: payload.username,
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: payload.selectedElementIds,
        color: { background: payload.color, stroke: payload.color },
      });
      collaborators.current = next;
      excalidrawAPI.updateScene({ collaborators: next });
    };

    socket.on("scene:patch", onPatch);
    socket.on("pages:update", onPages);
    socket.on("presence", onPresence);
    socket.on("pointer", onPointer);

    return () => {
      socket.off("scene:patch", onPatch);
      socket.off("pages:update", onPages);
      socket.off("presence", onPresence);
      socket.off("pointer", onPointer);
    };
  }, [boardId, excalidrawAPI, ensureFiles, openPage]);

  /**
   * Drop cursors for anyone who is no longer on our page. Without this, a
   * collaborator who switches away leaves a ghost cursor behind.
   */
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const onPage = new Set(
      users.filter((u) => u.pageId === activePageId).map((u) => u.socketId),
    );
    let changed = false;
    const next = new Map(collaborators.current);
    for (const socketId of next.keys()) {
      if (!onPage.has(socketId)) {
        next.delete(socketId);
        changed = true;
      }
    }
    if (changed) {
      collaborators.current = next;
      excalidrawAPI.updateScene({ collaborators: next });
    }
  }, [users, activePageId, excalidrawAPI]);

  /* --------------------------- client -> server -------------------------- */

  const onChange = useCallback(
    (_elements: readonly OrderedExcalidrawElement[], _appState: unknown, files: BinaryFiles) => {
      const pageId = activePageIdRef.current;
      if (!excalidrawAPI || !pageId) {
        return;
      }

      // Diff against what the server already has. Deletions come through as
      // elements with isDeleted set and a bumped version, which is why we read
      // the including-deleted list rather than onChange's argument.
      const all =
        excalidrawAPI.getSceneElementsIncludingDeleted() as readonly AnyElement[];
      const changed = all.filter(
        (el) => syncedVersions.current.get(el.id) !== el.version,
      );

      if (changed.length > 0) {
        for (const el of changed) {
          syncedVersions.current.set(el.id, el.version);
        }
        getSocket().emit("scene:push", { pageId, elements: changed });
      }

      for (const [fileId, file] of Object.entries(files)) {
        if (uploadedFiles.current.has(fileId)) {
          continue;
        }
        uploadedFiles.current.add(fileId);
        void api
          .uploadFile(boardId, {
            id: fileId,
            mimeType: file.mimeType,
            dataURL: file.dataURL as unknown as string,
          })
          .catch((err) => {
            uploadedFiles.current.delete(fileId);
            console.error("[sketchspace] file upload failed", err);
          });
      }
    },
    [boardId, excalidrawAPI],
  );

  const onPointerUpdate = useCallback(
    (payload: {
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "up" | "down";
    }) => {
      const pageId = activePageIdRef.current;
      if (!pageId || !excalidrawAPI) {
        return;
      }
      const now = Date.now();
      if (now - lastPointerSent.current < POINTER_INTERVAL_MS) {
        return;
      }
      lastPointerSent.current = now;

      getSocket().emit("pointer", {
        pageId,
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: excalidrawAPI.getAppState().selectedElementIds,
      });
    },
    [excalidrawAPI],
  );

  /* ------------------------------ page ops ------------------------------- */

  const createPage = useCallback(async () => {
    const { page } = await request<{ page: Page }>("page:create", {
      boardId,
      afterPageId: activePageIdRef.current,
    });
    await openPage(page.id);
  }, [boardId, openPage]);

  const renamePage = useCallback((pageId: string, name: string) => {
    getSocket().emit("page:rename", { pageId, name });
  }, []);

  const deletePage = useCallback((pageId: string) => {
    getSocket().emit("page:delete", { pageId });
  }, []);

  const movePage = useCallback(
    (pageId: string, afterPageId: string | null, beforePageId: string | null) => {
      getSocket().emit("page:move", { pageId, afterPageId, beforePageId });
    },
    [],
  );

  return {
    excalidrawAPI,
    setExcalidrawAPI,
    board,
    pages,
    activePageId,
    users,
    error,
    openPage,
    createPage,
    renamePage,
    deletePage,
    movePage,
    onChange,
    onPointerUpdate,
  };
};
