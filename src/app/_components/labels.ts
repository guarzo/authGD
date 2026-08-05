import "server-only";
import { getConfig } from "@/config";
import { resolveTierLabel } from "@/core/tier-labels";

/**
 * Display label for a tier, using this deployment's configured names.
 *
 * `server-only`: it reads config, so importing it from a client component is a
 * build error rather than a runtime one. That guarantee is the reason `Tier`
 * lives in its own module rather than in `ui.tsx`, which two client boundaries
 * import.
 */
export function tierLabel(tier: string): string {
  return resolveTierLabel(tier, getConfig().tierLabels);
}
