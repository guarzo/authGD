import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin-guard";

export const dynamic = "force-dynamic";

export default async function AdminIndex() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  redirect("/admin/accounts");
}
