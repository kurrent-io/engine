import { InMemStorage } from './storage';
import { Framework } from './framework';
import { clientProjector } from './reducers';
import {
  UserStoreProjectorContext,
  UserStoreQueryContext,
  LibraryEvents,
} from './library.gen';
import { generateUuid } from './util';

const typeset = {
  px: UserStoreProjectorContext,
  qx: UserStoreQueryContext,
  isEvent(_: LibraryEvents): true { return true; },
  isCommand(_: LibraryEvents): true { return true; },
};

const storage = new InMemStorage();

const fw = new Framework(typeset, storage, {
  shaper(events: LibraryEvents[]) {
    return {events, checkpoint: null};
  },
  projector: clientProjector,
});
