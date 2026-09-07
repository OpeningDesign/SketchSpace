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

