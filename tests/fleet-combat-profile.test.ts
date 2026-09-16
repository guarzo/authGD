import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMBAT_LIMITS,
  normalizeObservedName,
  observedNameKey,
  validateObservedName,
} from "@/core/fleet-combat-profile";
import profile from "@/core/fleet-combat-v2-profile.json";

// Vite's JSON transform rejects lone-surrogate JSON escapes. JSON.parse must
// deliver those external inputs unchanged so the production validator rejects them.
const fixture: {
  profile_sha256: string;
  derived_limits: Record<string, number | string[]>;
  names: {
    id: string;
    input: unknown;
    normalized: string | null;
    valid: boolean;
    key: string | null;
    normalized_key: string | null;
  }[];
} = JSON.parse(
  readFileSync(new URL("./fixtures/fleet-combat-v2.json", import.meta.url), "utf8"),
);

const digest = (path: URL) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("shared frozen combat profile", () => {
  it.each([
    "src/core/fleet-combat-v2-profile.json",
    "tests/fixtures/fleet-combat-v2.json",
  ])("preserves exact bytes through autocrlf checkout: %s", (relative) => {
    const repository = mkdtempSync(join(tmpdir(), "fleet-combat-checkout-"));
    try {
      const git = (...arguments_: string[]) =>
        execFileSync("git", arguments_, {
          cwd: repository,
          stdio: "pipe",
          timeout: 15000,
        });
      // Exercise actual checkout conversion without touching this checkout,
      // its index/config, or any commits.
      git("init", "--quiet");
      git("config", "--local", "core.autocrlf", "true");
      const root = fileURLToPath(new URL("../", import.meta.url));
      const attributes = join(root, ".gitattributes");
      if (existsSync(attributes))
        copyFileSync(attributes, join(repository, ".gitattributes"));
      const original = readFileSync(join(root, relative));
      const destination = join(repository, relative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, original);
      const control = join(repository, "unprotected.json");
      writeFileSync(control, '{"control":true}\n');
      git("add", "--all");
      unlinkSync(destination);
      unlinkSync(control);
      git("checkout-index", "--all", "--force");
      // Conversion must be active; a broad JSON exemption must not hide it.
      expect(readFileSync(control, "utf8")).toBe('{"control":true}\r\n');
      expect(createHash("sha256").update(readFileSync(destination)).digest("hex")).toBe(
        createHash("sha256").update(original).digest("hex"),
      );
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("pins the full shared fixture and installed profile bytes", () => {
    expect(digest(new URL("./fixtures/fleet-combat-v2.json", import.meta.url))).toBe(
      "d9ccb14c6142bf66afd9f49e1c859b73834cbdbb88be002fbe1e052115725b7c",
    );
    expect(
      digest(new URL("../src/core/fleet-combat-v2-profile.json", import.meta.url)),
    ).toBe(fixture.profile_sha256);
  });

  it.each(fixture.names)("name vector: $id", (vector) => {
    expect(normalizeObservedName(vector.input)).toBe(vector.normalized);
    expect(validateObservedName(vector.input)).toBe(vector.valid);
    expect(observedNameKey(vector.input)).toBe(vector.key);
    if (vector.normalized !== null) {
      expect(normalizeObservedName(vector.normalized)).toBe(vector.normalized);
      expect(validateObservedName(vector.normalized)).toBe(true);
      expect(observedNameKey(vector.normalized)).toBe(vector.normalized_key);
    }
  });

  it("exports every primary and derived limit immutably", () => {
    expect(COMBAT_LIMITS).toEqual({ ...profile.limits, ...fixture.derived_limits });
    expect(Object.isFrozen(COMBAT_LIMITS)).toBe(true);
    expect(Object.isFrozen(COMBAT_LIMITS.effect_order)).toBe(true);
    expect(Reflect.set(COMBAT_LIMITS, "observed_name_scalars", 1)).toBe(false);
    expect(Reflect.set(COMBAT_LIMITS.effect_order, "0", "NEUT")).toBe(false);
    expect(normalizeObservedName("A".repeat(64))).toBe("A".repeat(64));
  });

  it.each([undefined, 1n, Symbol("Pilot"), new String("Pilot"), () => "Pilot"])(
    "does not coerce a non-JSON external value: %s",
    (value) => {
      expect(normalizeObservedName(value)).toBeNull();
      expect(validateObservedName(value)).toBe(false);
      expect(observedNameKey(value)).toBeNull();
    },
  );
});
