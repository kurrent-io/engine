// View-model shapes shared by the server components (which receive them from
// the flight server's query) and the client components (which receive them as
// serialized props).

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
