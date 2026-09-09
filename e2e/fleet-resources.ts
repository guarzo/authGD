/** Register each owned acquisition before the next await; drain all in reverse. */
export async function withFleetResources<T>(
  run: (
    own: <R>(resource: R, dispose: (resource: R) => void | Promise<void>) => R,
  ) => Promise<T>,
): Promise<T> {
  const disposers: Array<() => void | Promise<void>> = [];
  let primary: unknown;
  let failed = false;
  let result!: T;
  try {
    result = await run((resource, dispose) => {
      disposers.push(() => dispose(resource));
      return resource;
    });
  } catch (error) {
    failed = true;
    primary = error;
  }
  const failures: unknown[] = [];
  for (const dispose of disposers.reverse()) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failed ? [primary, ...failures] : failures,
      "[fleet-e2e] owned resource cleanup failed",
    );
  if (failed) throw primary;
  return result;
}
