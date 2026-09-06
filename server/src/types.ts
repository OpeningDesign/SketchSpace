/**
 * Minimal structural view of an Excalidraw element. We deliberately do not
 * depend on @excalidraw/excalidraw on the server - we only need the four
 * fields reconciliation and ordering are defined over, and we round-trip
 * everything else untouched.
 */
export type SyncElement = {
  id: string;
  version: number;
  versionNonce: number;
  index?: string | null;
  isDeleted?: boolean;
  [key: string]: unknown;
};

export type Board = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type Page = {
  id: string;
  boardId: string;
  name: string;
  fracIndex: string;
  createdAt: number;
  updatedAt: number;
};

/** Per-socket presence, tracked in memory only. */
export type Presence = {
  socketId: string;
  username: string;
  color: string;
  boardId: string | null;
  pageId: string | null;
};
