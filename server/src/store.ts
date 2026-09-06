import { config } from "./config.js";
import { loadSceneJSON, saveSceneJSON } from "./db.js";
import { applyRemoteElements, orderElements } from "./reconcile.js";

import type { SyncElement } from "./types.js";

/**
 * Authoritative scene state.
 *
 * The server - not any one client - owns the canonical element map for each
 * page. Every incoming batch is reconciled against it using the same rule the
 * Excalidraw client uses, so a late joiner gets a correct snapshot and two
 * simultaneous editors converge. This is the piece first-draft never had: it
 * rebroadcasts draw events without ever reconciling them.
 *
 * Pages are held in memory while anyone has them open, written back to SQLite
 * on a debounce, and evicted a few minutes after the last viewer leaves.
 */
type CachedPage = {
  elements: Map<string, SyncElement>;
  dirty: boolean;
  persistTimer: NodeJS.Timeout | null;
  evictTimer: NodeJS.Timeout | null;
  viewers: number;
};

const pages = new Map<string, CachedPage>();

const load = (pageId: string): CachedPage => {
  const existing = pages.get(pageId);
  if (existing) {
    return existing;
  }

  let parsed: SyncElement[] = [];
  try {
    parsed = JSON.parse(loadSceneJSON(pageId)) as SyncElement[];
  } catch (error) {
    console.error(`[sketchspace] corrupt scene for page ${pageId}:`, error);
  }

  const page: CachedPage = {
    elements: new Map(parsed.map((el) => [el.id, el])),
    dirty: false,
    persistTimer: null,
    evictTimer: null,
    viewers: 0,
  };
  pages.set(pageId, page);
  return page;
};

const persist = (pageId: string): void => {
  const page = pages.get(pageId);
  if (!page || !page.dirty) {
    return;
  }
  const ordered = orderElements([...page.elements.values()]);
  saveSceneJSON(pageId, JSON.stringify(ordered));
  page.dirty = false;
};

const markDirty = (pageId: string, page: CachedPage): void => {
  page.dirty = true;
  if (page.persistTimer) {
    return;
  }
  page.persistTimer = setTimeout(() => {
    page.persistTimer = null;
    persist(pageId);
  }, config.persistDebounceMs);
};

/** Full ordered scene for a page, for handing to a client on open. */
export const getElements = (pageId: string): SyncElement[] =>
  orderElements([...load(pageId).elements.values()]);

/**
 * Reconciles an incoming batch and returns only the elements that won, so the
 * caller can rebroadcast a delta instead of the whole scene.
 */
export const applyUpdate = (
  pageId: string,
  incoming: readonly SyncElement[],
): SyncElement[] => {
  const page = load(pageId);
  const accepted = applyRemoteElements(page.elements, incoming);

  if (accepted.length > 0) {
    markDirty(pageId, page);
  }

  return accepted;
};

export const addViewer = (pageId: string): void => {
  const page = load(pageId);
  page.viewers++;
  if (page.evictTimer) {
    clearTimeout(page.evictTimer);
    page.evictTimer = null;
  }
};

export const removeViewer = (pageId: string): void => {
  const page = pages.get(pageId);
  if (!page) {
    return;
  }
  page.viewers = Math.max(0, page.viewers - 1);

  if (page.viewers === 0 && !page.evictTimer) {
    page.evictTimer = setTimeout(() => {
      persist(pageId);
      if (page.persistTimer) {
        clearTimeout(page.persistTimer);
      }
      pages.delete(pageId);
    }, config.pageEvictionMs);
  }
};

/** Flush everything - called on shutdown so nothing dirty is lost. */
export const flushAll = (): void => {
  for (const pageId of pages.keys()) {
    persist(pageId);
  }
};
