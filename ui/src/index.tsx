import { createRoot } from 'react-dom/client';

import {
  InMemStorage,
  UserFramework,
  UserQueryContext,
  AddEdition,
  AddBook,
  userMigrate,
  userReducer,
} from './model';

import App from './App';
import './styles.css';
import { generateUuid } from './util';

const storage = new InMemStorage();

const fw = new UserFramework(storage, {
  migrate: userMigrate,
  reducer: userReducer,
});

// populate the storage with some initial data
fw.recvEvents([{
  type: "add-patron",
  id: "my-patron-id",
  name: "JoeBob",
  researcher: true,
  timestamp: new Date(),
}], null);

export type FW = typeof fw;
export type QX = typeof UserQueryContext;

const bookUuids: string[] = [];

export function makeAddBook(fw: FW): () => void {
  let count = 0;
  const editions: Omit<AddEdition, "timestamp">[] = [
    {
      type: "add-edition",
      isbn: "1-2-3",
      title: "Kurrent Events: events in your frontend",
    },
    {
      type: "add-edition",
      isbn: "4-5-6",
      title: "Event Sourcing: The new old pattern",
    },
    {
      type: "add-edition",
      isbn: "7-8-9",
      title: "Stop Writing Backends",
    },
  ];

  const books: Omit<AddBook, "timestamp"|"id">[] = [
    {
      type: "add-book",
      isbn: "1-2-3",
      restricted: false,
    },
    {
      type: "add-book",
      isbn: "4-5-6",
      restricted: false,
    },
    {
      type: "add-book",
      isbn: "7-8-9",
      restricted: false,
    }
  ];
  return () => {
    // on first pass, include editions
    if (count < editions.length) {
      fw.recvEvents([{...editions[count], timestamp: new Date()}], null);
    }
    // then add books
    const bookUuid = generateUuid();
    bookUuids.push(bookUuid);
    fw.recvEvents([{...books[count % books.length], timestamp: new Date(), id: bookUuid}], null);
    count++;
  };
}

export function makeAddCheckout(fw: FW): () => void {
  let count = 0;
  return () => {
    console.log("add checkout");
    fw.recvEvents([{
      type: "new-vcheckout",
      id: generateUuid(),
      book: bookUuids[count % bookUuids.length],
      expires: new Date((new Date()).getTime() + 1000 * 60 * 60 * 24 * 5),
      patron: "my-patron-id",
    }], null);
    count++;
  }
}

export function makeRetitleBook(fw: FW): () => void {
  let count = 0;
  const isbns = ["1-2-3", "4-5-6", "7-8-9"];
  return () => {
    console.log("retitle-book");
    fw.recvEvents([{
      type: "update-edition-title",
      isbn: isbns[count % isbns.length],
      title: `star wars ${count + 1}: a new title`,
      timestamp: new Date(),
    }], null);
    count++;
  }
}

const container = document.getElementById('root');
const root = createRoot(container!);

// don't let render happen until our patron is in the database
setTimeout(() => root.render(<App fw={fw}/>));
