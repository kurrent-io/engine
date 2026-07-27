// View-model shapes produced by queries and consumed by components.  Server
// query results cross the websocket as JSON, so everything here must be
// plain serializable data.

export type ItemView = {
  id: string;
  text: string;
  done: boolean;
};

export type ListData = {
  id: string;
  name: string;
  items: ItemView[];
};

export type BoardStats = {
  lists: number;
  items: number;
  done: number;
};

export type ListStats = {
  total: number;
  done: number;
};

export type ArchiveStats = {
  lists: number;
  items: number;
};
