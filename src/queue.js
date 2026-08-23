// A single-lane async queue for MTProto calls. One Telegram account should not
// fan out history/media requests in parallel and invite FLOOD_WAIT responses.
export function createSerialQueue() {
  let chain = Promise.resolve();

  return function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
