import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readRequired(relativePath) {
  return readFile(join(skillRoot, relativePath), "utf8");
}

test("manual skill metadata keeps the recruitment-review entrypoint explicit and compact", async () => {
  const source = await readRequired("SKILL.md");
  const lines = source.replace(/\n$/, "").split("\n");
  const frontmatterEnd = lines.indexOf("---", 1);

  assert.equal(lines[0], "---");
  assert.ok(frontmatterEnd > 1, "frontmatter must have a closing delimiter");
  const frontmatter = lines.slice(1, frontmatterEnd);
  assert.ok(frontmatter.includes("name: recruitment-review"));
  assert.ok(frontmatter.includes("disable-model-invocation: true"));

  const descriptionLine = frontmatter.find((line) => line.startsWith("description: "));
  assert.ok(descriptionLine, "description must be present and non-empty");
  const description = descriptionLine.slice("description: ".length).trim();
  assert.ok(description.length > 0, "description must be non-empty");
  assert.ok(description.length < 1024, "description must be fewer than 1024 characters");
  assert.ok(lines.length < 100, "SKILL.md must remain fewer than 100 lines");
});

test("manual skill ships both references required during a review", async () => {
  const [inputFormat, rubric] = await Promise.all([
    readRequired("references/input-format.md"),
    readRequired("references/review-rubric.md"),
  ]);

  assert.ok(inputFormat.trim().length > 0);
  assert.ok(rubric.trim().length > 0);
});
