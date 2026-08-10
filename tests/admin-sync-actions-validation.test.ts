import { describe, expect, it, vi } from "vitest";

// The guard runs before jobType validation in syncJobAction, so it must
// resolve for this test to reach that check at all — mocked rather than
// exercised for real, the same pattern health-routes-db-down.test.ts uses for
// a different dependency. Nothing below this mock touches a real database:
// the schema rejection throws before enqueueSync/logAudit/getDb are ever
// called.
vi.mock("@/lib/admin-guard", () => ({
  requireAdminAction: async () => ({ accountId: "00000000-0000-0000-0000-000000000000" }),
}));

const { syncJobAction } = await import("@/app/admin/sync/actions");

describe("syncJobAction — jobType validation", () => {
  it("rejects a jobType outside @/core/schedules's own JOB_CRON with invalid_job_type", async () => {
    const formData = new FormData();
    formData.set("jobType", "not-a-real-job");
    await expect(syncJobAction(null, formData)).rejects.toThrow("invalid_job_type");
  });

  it("rejects a missing jobType field with invalid_job_type", async () => {
    await expect(syncJobAction(null, new FormData())).rejects.toThrow("invalid_job_type");
  });
});
