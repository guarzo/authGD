import { DrizzleQueryError } from "drizzle-orm";
import { DatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import { classifyError, isSqlState } from "../scripts/fleet-esi-feasibility";

/** A `DatabaseError`-shaped cause without going through pg's wire parser. */
function fakeDatabaseError(code: string): DatabaseError {
  const err = new DatabaseError("synthetic", 0, "error");
  err.code = code;
  err.detail = "Key (owner_hash)=(abc123) already exists.";
  err.table = "character";
  err.column = "owner_hash";
  err.constraint = "character_owner_hash_key";
  return err;
}

describe("isSqlState", () => {
  it("accepts a five-character alphanumeric code", () => {
    expect(isSqlState("23505")).toBe(true);
    expect(isSqlState("3D000")).toBe(true);
  });

  it("rejects anything not shaped like a SQLSTATE", () => {
    for (const value of [
      "ECONNREFUSED", // node system error code, wrong length
      "abcde", // lowercase — real SQLSTATEs are uppercase
      "1234", // too short
      "123456", // too long
      undefined,
      null,
      42,
      {},
    ]) {
      expect(isSqlState(value)).toBe(false);
    }
  });
});

describe("classifyError", () => {
  it("reports just the constructor name when there is no recognizable cause", () => {
    expect(classifyError(new Error("boom"))).toBe("Error");
    expect(classifyError(new TypeError("nope"))).toBe("TypeError");
  });

  it("returns a fixed fallback for a thrown non-Error", () => {
    expect(classifyError("just a string")).toBe("unknown error");
    expect(classifyError(undefined)).toBe("unknown error");
    expect(classifyError({ message: "not an Error instance" })).toBe("unknown error");
  });

  it("appends the SQLSTATE when the cause carries a recognizable one", () => {
    const cause = fakeDatabaseError("23505"); // unique_violation
    const err = new DrizzleQueryError(
      "insert into character (owner_hash) values ($1)",
      ["abc123"],
      cause,
    );
    expect(classifyError(err)).toBe("DrizzleQueryError sqlstate=23505");
  });

  it("falls back to the constructor name when the cause's code is not SQLSTATE-shaped", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const err = new DrizzleQueryError("select 1", [], cause);
    expect(classifyError(err)).toBe("DrizzleQueryError");
  });

  it("falls back to the constructor name when the cause has no code at all", () => {
    const err = new DrizzleQueryError("select 1", [], new Error("plain failure"));
    expect(classifyError(err)).toBe("DrizzleQueryError");
  });

  it("never leaks the query, its parameters, or the cause's detail/table/column", () => {
    const cause = fakeDatabaseError("23505");
    const err = new DrizzleQueryError(
      "insert into character (owner_hash) values ($1)",
      ["a-secret-owner-hash"],
      cause,
    );
    const out = classifyError(err);
    expect(out).not.toMatch(/insert|select|character|owner_hash|secret/i);
    expect(out).toBe("DrizzleQueryError sqlstate=23505");
  });
});
