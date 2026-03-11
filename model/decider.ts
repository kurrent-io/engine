export {
  Framework,
  InMemStorage,
  DeciderReducerContext,
  DecodeLibraryEvents,
  ExternalCallbackStorage } from "./library.gen";
export { deciderReducer } from "./reducers";

import { LibraryEvents } from "./library.gen";

export function deciderShaper(events: LibraryEvents[]): {events: LibraryEvents[], checkpoint: unknown} {
  return {events, checkpoint: null};
}
