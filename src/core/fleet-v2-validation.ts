import { z } from "zod";

/** Zod 4 skips own __proto__ keys even on strict objects. Validate the original
 * structured value BEFORE schema parsing can erase that evidence. Shared by
 * wire requests and precommit output; reusable by future browser Off input.
 * String values are untouched. Active ancestors detect cycles; completed nodes
 * permit ordinary DAG aliases without repeatedly walking a shared subtree.
 */
export function safeParseFleetV2Dto<T>(
  schema: z.ZodType<T>,
  value: unknown,
): z.ZodSafeParseSuccess<T> | z.ZodSafeParseError<unknown> {
  const active = new WeakSet<object>();
  const completed = new WeakSet<object>();
  const pending: { value: unknown; exit: boolean }[] = [{ value, exit: false }];
  while (pending.length) {
    const frame = pending.pop()!;
    const node = frame.value;
    if (node === null || typeof node !== "object") continue;
    if (frame.exit) {
      active.delete(node);
      completed.add(node);
      continue;
    }
    if (completed.has(node)) continue;
    if (active.has(node) || Object.hasOwn(node, "__proto__")) {
      return {
        success: false,
        error: new z.ZodError([
          { code: "custom", path: [], message: "cyclic or forbidden-key fleet DTO" },
        ]),
      };
    }
    active.add(node);
    pending.push({ value: node, exit: true });
    for (const child of Object.values(node)) pending.push({ value: child, exit: false });
  }
  return schema.safeParse(value);
}
