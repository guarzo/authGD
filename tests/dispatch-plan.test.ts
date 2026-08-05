import { describe, expect, it } from "vitest";
import { jobsFor, type OutboxPayload } from "@/core/dispatch-plan";

describe("jobsFor", () => {
  it("fans an account payload out to scoped membership/roles and global contacts/wanderer", () => {
    const jobs = jobsFor({ kind: "account", accountId: "acc-1" });
    expect(jobs.map((j) => j.jobType).sort()).toEqual([
      "contacts",
      "discord-roles",
      "membership",
      "wanderer",
    ]);
    expect(jobs.find((j) => j.jobType === "membership")).toEqual({
      jobType: "membership",
      accountId: "acc-1",
    });
    expect(jobs.find((j) => j.jobType === "discord-roles")).toEqual({
      jobType: "discord-roles",
      accountId: "acc-1",
    });
    expect(jobs.find((j) => j.jobType === "contacts")).toEqual({ jobType: "contacts" });
    expect(jobs.find((j) => j.jobType === "wanderer")).toEqual({ jobType: "wanderer" });
  });

  it("maps a discord-user payload to a discord-user-scoped roles job", () => {
    expect(jobsFor({ kind: "discord-user", discordUserId: "u9" })).toEqual([
      { jobType: "discord-roles", discordUserId: "u9" },
    ]);
  });

  it("maps membership-recheck to itself, unscoped", () => {
    expect(jobsFor({ kind: "membership-recheck" })).toEqual([
      { jobType: "membership-recheck" },
    ]);
  });

  it("maps 'all' to the four sweep job types, unscoped", () => {
    expect(
      jobsFor({ kind: "all" })
        .map((j) => j.jobType)
        .sort(),
    ).toEqual(["contacts", "discord-roles", "membership", "wanderer"]);
  });

  it.each([
    "membership",
    "contacts",
    "wanderer",
    "discord-roles",
    "membership-recheck",
    "token-health",
    "purge",
  ])("maps a job re-run of %s to itself, unscoped", (jobType) => {
    expect(jobsFor({ kind: "job", jobType })).toEqual([{ jobType }]);
  });

  it.each(["ops-dead-letter", "not-a-queue", "", "membership; DROP"])(
    "targets nothing for an unrunnable job re-run of %j",
    (jobType) => {
      expect(jobsFor({ kind: "job", jobType })).toEqual([]);
    },
  );

  it("targets nothing for an unrecognized kind", () => {
    expect(jobsFor({ kind: "from-the-future" } as unknown as OutboxPayload)).toEqual([]);
  });

  it.each([
    ["json null", null],
    ["a bare string", "membership"],
    ["a number", 7],
    ["an array", []],
    ["an object with no kind", { accountId: "acc-1" }],
  ])("targets nothing for %s rather than throwing", (_label, payload) => {
    expect(jobsFor(payload as unknown as OutboxPayload)).toEqual([]);
  });
});
