export {
  Framework,
  InMemStorage,
  DeciderStoreProjectorContext,
  DecodeLibraryEvents,
  ExternalCallbackStorage } from "./library.gen";
export { deciderProjector } from "./reducers";

import { LibraryEvents } from "./library.gen";

export function deciderShaper(events: LibraryEvents[]): {events: LibraryEvents[], checkpoint: unknown} {
  return {events, checkpoint: null};
}
