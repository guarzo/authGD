import { expect } from "vitest";

/**
 * `error.message` from node-postgres is Drizzle's generic "Failed query:
 * ..." wrapper — the driver puts the actual Postgres error (and the
 * violated constraint's name) on `.cause`. Assert there so these tests
 * verify the DB rejected the specific constraint, not just "some" error: a
 * bare `rejects.toThrow()` also passes when the insert dies on a typo'd
 * column or a missing FK, which is not what any of these tests mean.
 *
 * Kept out of ./db.ts because that module is loaded by the Vitest global
 * setup, which runs outside the worker context `expect` requires.
 */
export async function expectCheckViolation(
  promise: Promise<unknown>,
  constraintName: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringContaining(constraintName),
    }),
  });
}
