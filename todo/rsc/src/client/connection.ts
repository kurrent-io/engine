// Module-level connection singleton.  The bootstrap in index.tsx owns the
// websocket and keeps this up to date; client components import sendCommand.

let socket: WebSocket | null = null;

export function setSocket(ws: WebSocket | null) {
  socket = ws;
}

export function sendCommand(command: { type: string } & Record<string, unknown>) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.error('not connected; dropping command', command);
    return;
  }
  socket.send(JSON.stringify({ command }));
}
