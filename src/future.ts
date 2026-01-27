/* A Future is a function that yields nothing, is woken up with nothing, and eventually returns T */
export type Future<T> = Generator<void, T, void>;

/* A FutureContext corresponds to the first generator in our callstack.  Though it may be delegating
   yields to some child generator through yield* statements, when a condition is met to wake up the
   child, the .next() has to be sent to the root generator, not the child (or grandchild).

   FutureContext makes that trivial. */
export class FutureContext {
  #coro: Generator;
  #awake: boolean = false;

  constructor(coro: Generator) {
    this.#coro = coro;
  }

  wakeup() {
    // disallow calls to the base wakeup from inside the base wakeup
    if (this.#awake) return;
    this.#awake = true;
    try {
      this.#coro.next();
    } finally {
      this.#awake = false;
    }
  }

  throw(e: Error) {
    // if we're actually inside the coro, throw the error now
    if (this.#awake) throw(e);
    this.#awake = true;
    try {
      this.#coro.throw(e);
    } finally {
      this.#awake = false;
    }
  }
}
