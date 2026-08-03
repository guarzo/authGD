/**
 * Deploy-time live smoke check for the Wanderer client (Plan 2 confirmed the
 * API contract from wanderer's source but never ran it live). Performs a
 * read → add → re-read → remove → re-read pass with a THROWAWAY character id
 * you supply (any real EVE character id NOT already on the ACL — e.g. an alt).
 *
 * Usage (with production env vars exported, e.g. via `fly ssh console`):
 *   npm run smoke:wanderer -- <characterId>
 */
import { loadConfig } from "@/config";
import { createWandererClient } from "@/lib/wanderer/client";

async function main() {
  const arg = process.argv[2];
  if (!arg || !/^\d+$/.test(arg)) {
    console.error("usage: npm run smoke:wanderer -- <test character id>");
    process.exit(2);
  }
  const characterId = Number(arg);
  const cfg = loadConfig();
  const wanderer = createWandererClient(cfg);

  const before = await wanderer.getAclMembers();
  console.log(`READ ok — ${before.length} ACL members`);
  if (before.some((m) => m.characterId === characterId)) {
    console.error(
      `character ${characterId} is ALREADY on the ACL — refusing to touch a real member; use a throwaway id`,
    );
    process.exit(2);
  }

  await wanderer.addAclMember(characterId);
  let removed = false;
  try {
    const afterAdd = await wanderer.getAclMembers();
    if (!afterAdd.some((m) => m.characterId === characterId)) {
      throw new Error("ADD not visible on re-read");
    }
    console.log("ADD ok — member visible on re-read");

    await wanderer.removeAclMember(characterId);
    const afterRemove = await wanderer.getAclMembers();
    if (afterRemove.some((m) => m.characterId === characterId)) {
      throw new Error("REMOVE not visible on re-read");
    }
    // Only after absence is CONFIRMED — if the member is still present, the
    // finally block must retry the removal.
    removed = true;
    console.log("REMOVE ok — member gone on re-read");
    console.log("PASS: wanderer client contract verified live");
  } finally {
    // Never leave the throwaway character with live map access: any failure
    // after the add still attempts cleanup, loudly.
    if (!removed) {
      try {
        await wanderer.removeAclMember(characterId);
        console.error(`cleanup: removed ${characterId} from the ACL after a failure`);
      } catch (cleanupErr) {
        console.error(
          `cleanup FAILED — character ${characterId} may STILL BE ON THE ACL ` +
            `(id ${cfg.wanderer.aclId}). Remove it manually in Wanderer now.`,
          cleanupErr,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
