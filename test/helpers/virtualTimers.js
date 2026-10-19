// -----------------------------------------------------------------------------
// Virtual-time timers (from the review scenarios): a timer fires only when
// the clock reaches it; advance() moves the clock step by step and lets the
// promises settle between steps.
// -----------------------------------------------------------------------------

export const flush = async () => {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

export function virtualTimers(clock) {
  let next = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) {
      const id = next;
      next += 1;
      pending.set(id, { id, fn, at: clock.now + Math.max(0, ms) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async advance(ms, step = 1000) {
      const end = clock.now + ms;
      while (clock.now < end) {
        clock.now = Math.min(end, clock.now + step);
        for (;;) {
          const due = [...pending.values()]
            .filter((t) => t.at <= clock.now)
            .sort((a, b) => a.at - b.at);
          if (due.length === 0) break;
          for (const t of due) {
            pending.delete(t.id);
            t.fn();
          }
          await flush();
        }
      }
      await flush();
    },
  };
}
