/** pg-boss can recover after emitting an error. Eventual activation must not
 * erase that failure from the proof. Own this assertion BEFORE all resources
 * so reverse cleanup evaluates it after their complete stop/drain sequence. */
export function createFleetQueueErrorOwner() {
  let failed = false;
  return {
    record: () => {
      failed = true;
    },
    close() {
      if (failed) throw new Error("[fleet-e2e] unexpected queue error event");
    },
  };
}
