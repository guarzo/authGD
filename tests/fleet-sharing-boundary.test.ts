import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** A source-level tripwire for supported application writers, not a claim to
 * prevent arbitrary administrator SQL. Delete/read remain legal for cutover. */
function writesLegacyEligibility(source: string): boolean {
  const file = ts.createSourceFile("guard.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["fleetEligibility"]);
  function aliases(node: ts.Node) {
    if (ts.isImportSpecifier(node) && node.propertyName?.text === "fleetEligibility")
      names.add(node.name.text);
    ts.forEachChild(node, aliases);
  }
  aliases(file);
  let found =
    /\b(?:insert\s+into|update|merge\s+into)\s+(?:"?public"?\.)?"?fleet_eligibility\b/i.test(
      source,
    );
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["insert", "update"].includes(node.expression.name.text)
    ) {
      const target = node.arguments[0];
      if (
        target &&
        ((ts.isIdentifier(target) && names.has(target.text)) ||
          (ts.isPropertyAccessExpression(target) &&
            target.name.text === "fleetEligibility"))
      )
        found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const name = join(path, entry.name);
    return entry.isDirectory()
      ? sourceFiles(name)
      : /\.[cm]?tsx?$/.test(name)
        ? [name]
        : [];
  });
}

describe("legacy fleet authority cutover boundary", () => {
  it.each([
    "tx.insert(fleetEligibility).values(row)",
    "tx.update(fleetEligibility).set(row)",
    "import { fleetEligibility as legacy } from '@/db/schema'; tx.insert(legacy).values(row)",
    "tx.insert(schema.fleetEligibility).values(row)",
    'sql`INSERT INTO "public"."fleet_eligibility" VALUES (...)`',
  ])("detects a forbidden production writer: %s", (source) => {
    expect(writesLegacyEligibility(source)).toBe(true);
  });

  it("allows read and delete but no production eligibility writer or compatibility mirror", () => {
    expect(
      writesLegacyEligibility(
        "tx.delete(fleetEligibility); tx.select().from(fleetEligibility)",
      ),
    ).toBe(false);
    const writers = [...sourceFiles("src"), ...sourceFiles("scripts")].filter((path) =>
      writesLegacyEligibility(readFileSync(path, "utf8")),
    );
    expect(writers).toEqual([]);
  });
});
