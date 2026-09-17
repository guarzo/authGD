export type FixturePath = (string | number)[];
export type CodecVector = {
  name: string;
  decoder: string;
  accept: boolean;
  base?: string;
  input?: unknown;
  set?: [FixturePath, unknown][];
  remove?: FixturePath[];
  expect_path?: FixturePath;
  expect?: unknown;
  command?: unknown;
  command_set?: [FixturePath, unknown][];
};

/** Recipes only — acceptance belongs to the production helpers. */
export function materializeCodec(
  bases: Record<string, unknown>,
  vector: CodecVector,
): unknown {
  const value = structuredClone(
    vector.base === undefined ? vector.input : bases[vector.base],
  );
  for (const [path, replacement] of vector.set ?? []) {
    const parent = fixtureField(value, path.slice(0, -1)) as Record<
      string | number,
      unknown
    >;
    parent[path[path.length - 1]] = structuredClone(replacement);
  }
  for (const path of vector.remove ?? []) {
    const parent = fixtureField(value, path.slice(0, -1)) as Record<
      string | number,
      unknown
    >;
    delete parent[path[path.length - 1]];
  }
  return value;
}

/** Original request context is independent of mutations to the response. Apply
 * command_set last, on a detached clone, exactly as the approved recipe specifies. */
export function materializeCommand(vector: CodecVector): unknown {
  if (vector.command === undefined) {
    if (vector.command_set !== undefined)
      throw new Error(`Missing command: ${vector.name}`);
    return undefined;
  }
  return materializeCodec(
    {},
    {
      name: vector.name,
      decoder: vector.decoder,
      accept: vector.accept,
      input: vector.command,
      set: vector.command_set,
    },
  );
}

export type ListVector = {
  name: string;
  decoder: string;
  count: number;
  accept: boolean;
};

export function materializeList(
  bases: Record<string, unknown>,
  vector: ListVector,
): unknown {
  const value = structuredClone(bases[vector.decoder]) as {
    rows: Record<string, unknown>[];
  };
  const row = value.rows[0];
  value.rows = Array.from({ length: vector.count }, (_, index) => ({
    ...structuredClone(row),
    character_id: index + 1,
    // UUID(int=index, version=4) for these bounded list indexes, including zero.
    ...(vector.decoder === "combat_get"
      ? {
          publication_id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        }
      : {}),
  }));
  return value;
}

export function fixtureField(value: unknown, path: FixturePath): unknown {
  for (const key of path) value = (value as Record<string | number, unknown>)[key];
  return value;
}
