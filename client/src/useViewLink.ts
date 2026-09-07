import { getVisibleSceneBounds } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/**
 * Keep the address bar pointing at what you are actually looking at.
 *
 * The URL carries the board, the sheet, and the visible region:
 *
 *   #/board/<boardId>/<pageId>?v=<x1>,<y1>,<x2>,<y2>
 *
 * so "look at this detail on A501" is a link rather than a description. Panning
 * and zooming rewrite it with `replaceState`, so copying the address bar always
 * shares the current view and the back button is not filled with noise.
 *
 * Modelled on first-draft's URL view sharing
 * (gitlab.com/MeldCE/first-draft !69), which encodes the viewport as l/t/r/b/z
 * query parameters. Excalidraw's own `setViewport({ target: bounds })` takes a
 * scene-coordinate box directly, so the same idea needs no maths of our own.
 */

/** Pan/zoom fires continuously; one URL rewrite per this interval is plenty. */
const REWRITE_MS = 400;

const round = (n: number) => Math.round(n * 10) / 10;

export const parseViewParam = (hash: string): [number, number, number, number] | null => {
  const raw = /[?&]v=([-\d.,]+)/.exec(hash)?.[1];
  if (!raw) {
    return null;
  }
  const parts = raw.split(",").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isFinite(n))
    ? (parts as [number, number, number, number])
    : null;
};

export const useViewLink = (
  excalidrawAPI: ExcalidrawImperativeAPI | null,
  boardId: string,
  activePageId: string | null,
) => {
  const lastWrite = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pages whose incoming view we have already honoured. */
  const applied = useRef(new Set<string>());

  const writeUrl = useCallback(() => {
    if (!excalidrawAPI || !activePageId) {
      return;
    }
    const bounds = getVisibleSceneBounds(excalidrawAPI.getAppState());
    const v = bounds.map(round).join(",");
    const next = `#/board/${boardId}/${activePageId}?v=${v}`;
    if (window.location.hash !== next) {
      // replaceState, not a hash assignment: this must not create history
      // entries, and must not fire hashchange and bounce the router.
      window.history.replaceState(null, "", next);
    }
  }, [excalidrawAPI, boardId, activePageId]);

  /** Call from Excalidraw's onScrollChange. */
  const onViewChange = useCallback(() => {
    const now = Date.now();
    const wait = Math.max(0, REWRITE_MS - (now - lastWrite.current));
    if (pending.current) {
      clearTimeout(pending.current);
    }
    pending.current = setTimeout(() => {
      pending.current = null;
      lastWrite.current = Date.now();
      writeUrl();
    }, wait);
  }, [writeUrl]);

  // Apply an incoming view once per page, then let panning take over.
  useEffect(() => {
    if (!excalidrawAPI || !activePageId || applied.current.has(activePageId)) {
      return;
    }
    applied.current.add(activePageId);

    const bounds = parseViewParam(window.location.hash);
    if (bounds) {
      excalidrawAPI.setViewport({ target: bounds, fit: "contain" });
    } else {
      // No view asked for, but the tab changed - keep the URL honest.
      writeUrl();
    }
  }, [excalidrawAPI, activePageId, writeUrl]);

  useEffect(
    () => () => {
      if (pending.current) {
        clearTimeout(pending.current);
      }
    },
    [],
  );

  return { onViewChange };
};
