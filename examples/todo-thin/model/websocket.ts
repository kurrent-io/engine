// websocket types for ui and server communication

export type ClientMessage = {
  // new commands to be written to the database
  commands?: { id: string; data: any }[];
  // new queries to start watching (maps query id to query args)
  subscribeQueries?: Record<string, any[]>;
  // queries to stop watching (list of query ids)
  closeQueries?: string[];
};

export type ServerMessage = {
  // server acks N more commands from this connection
  acks?: number;
  // queries with fresh results (maps query id to query results)
  queryResults?: Record<string, any>;
};
