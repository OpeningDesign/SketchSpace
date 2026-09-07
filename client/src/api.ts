import type { Board, PushResult } from "./types";

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

  /**
   * Write drawing positions back into the board's Bonsai layout.
   * Always preview with dryRun before writing - this touches the user's repo.
   */
  pushLayout: (boardId: string, dryRun: boolean) =>
    fetch(`/api/boards/${boardId}/push-layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun }),
    }).then((r) => json<PushResult>(r)),

  uploadFile: (
    boardId: string,
    file: { id: string; mimeType: string; dataURL: string },
  ) =>
    fetch(`/api/boards/${boardId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file),
    }).then((r) => json(r)),

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
