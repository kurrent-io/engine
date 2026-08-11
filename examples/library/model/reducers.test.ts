import { UserReducerTester } from './library.gen';
import { userMigrate, userReducer } from './reducers';

test('user reducer', () => {
  // do the usual startup migration
  const t = new UserReducerTester(userMigrate, userReducer);

  // populate some initial data
  t.run([
    { type: 'add-edition', isbn: 'isbn-1', title: 'title-1', timestamp: new Date() },
    { type: 'add-book', id: 'book-1', isbn: 'isbn-1', restricted: false, timestamp: new Date() },
    { type: 'add-book', id: 'book-2', isbn: 'isbn-1', restricted: true, timestamp: new Date() },
    { type: 'add-patron', id: 'patron-1', name: 'Alice', researcher: false, timestamp: new Date() },
  ]);
  expect(t.data.editions()).toStrictEqual({ 'isbn-1': true });
  expect(t.data.edition('isbn-1').books).toStrictEqual({ 'book-1': true, 'book-2': true });
  expect(t.data.edition('isbn-1').holds).toStrictEqual({});
  expect(t.data.patrons()).toStrictEqual({ 'patron-1': true });

  // pretend we sent a try-hold and got a new-vhold back
  let result = t.run([
    {
      type: 'new-vhold',
      id: 'hold-1',
      patron: 'patron-1',
      target: { edition: 'isbn-1' },
      open: false,
      timestamp: new Date(),
    },
  ]);
  expect(result.updates).toStrictEqual(['edition.isbn-1', 'hold.hold-1', 'patron.patron-1']);
  expect(result.markedSent).toStrictEqual([{ type: 'try-hold', id: 'hold-1' }]);
  expect(t.data.edition('isbn-1').holds).toStrictEqual({ 'hold-1': true });
  expect(t.data.patron('patron-1').holds).toStrictEqual({ 'hold-1': true });

  // hold was canceled
  result = t.run([{ type: 'cancel-hold', id: 'hold-1' }]);
  expect(result.updates).toStrictEqual(['edition.isbn-1', 'hold.hold-1', 'patron.patron-1']);
  expect(result.markedSent).toStrictEqual([]);
  expect(t.data.edition('isbn-1').holds).toStrictEqual({});
  expect(t.data.patron('patron-1').holds).toStrictEqual({});

  // pretend we sent a try-hold and got a vhold-rejected back
  result = t.run([
    { type: 'vhold-rejected', id: 'hold-2', reason: 'just cuz', patron: 'patron-1' },
  ]);
  expect(result.updates).toStrictEqual(['messages']);
  expect(result.markedSent).toStrictEqual([{ type: 'try-hold', id: 'hold-2' }]);
  expect(t.data.messages()).toStrictEqual(['just cuz']);
});
