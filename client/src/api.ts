import type { Board } from "./types";

/** Which placement an edit is about, taken from the element's customData. */
export type BonsaiRef = {
  layout: string;
  groupKey: string;
  kind?: string;
  globalId?: string | null;
};

export type EditableField = {
  name: string;
  value: string;
  editable: boolean;
  reason?: string;
};

export type ViewFields = {
  sheet: string;
  view: string;
  connected: boolean;
  fields: EditableField[];
  note?: string;
};

const json = async <T,>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
};

export const api = {
  session: () =>
    fetch("/api/session").then((r) => json<{ authed: boolean }>(r)),

  login: (password: string) =>
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((r) => json<{ ok: true }>(r)),

  logout: () => fetch("/api/logout", { method: "POST" }).then((r) => json(r)),

  listBoards: () =>
    fetch("/api/boards").then((r) => json<{ boards: Board[] }>(r)),

  createBoard: (name: string) =>
    fetch("/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => json<{ board: Board }>(r)),

  deleteBoard: (id: string) =>
    fetch(`/api/boards/${id}`, { method: "DELETE" }).then((r) => json(r)),

  renameBoard: (id: string, name: string) =>
    fetch(`/api/boards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => json(r)),

  uploadFile: (
    boardId: string,
    file: { id: string; mimeType: string; dataURL: string },
  ) =>
    fetch(`/api/boards/${boardId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file),
    }).then((r) => json(r)),

  /** The template fields behind a selected placement - see server/bonsaiEdit.ts. */
  bonsaiFields: (ref: BonsaiRef) =>
    fetch("/api/bonsai/fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ref),
    }).then((r) => json<ViewFields>(r)),

  /** Type those values back into the model Blender has open. */
  setBonsaiValues: (ref: BonsaiRef, values: Record<string, string>) =>
    fetch("/api/bonsai/values", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ref, values }),
    }).then((r) => json<{ changed: string[]; layout: string }>(r)),

  fetchFiles: (boardId: string, ids: string[]) =>
    fetch(
      `/api/boards/${boardId}/files?ids=${encodeURIComponent(ids.join(","))}`,
    ).then((r) =>
      json<{
        files: {
          id: string;
          mimeType: string;
          dataURL: string;
          created: number;
        }[];
      }>(r),
    ),
};
