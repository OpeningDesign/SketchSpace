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

export type PresenceUser = {
  socketId: string;
  username: string;
  color: string;
  boardId: string | null;
  pageId: string | null;
};

export type MovedDrawing = {
  groupKey: string;
  globalId: string | null;
  kind: string;
  /** Millimetres, relative to where the layout currently has it. */
  dx: number;
  dy: number;
  warnings: string[];
};

export type PushResult = {
  written: boolean;
  layouts: { layoutPath: string; pageName: string; moved: MovedDrawing[] }[];
  errors: string[];
  total: number;
};
