export const RECRUITMENT_SCOPES = [
  "esi-wallet.read_character_wallet.v1",
  "esi-contracts.read_character_contracts.v1",
  "esi-assets.read_assets.v1",
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
] as const;

export const RECRUITMENT_CATEGORIES = [
  "corporation-history",
  "wallet",
  "contracts",
  "assets",
  "skills",
  "skill-queue",
] as const;
export type RecruitmentCategory = (typeof RECRUITMENT_CATEGORIES)[number];
export type RecruitmentStatus =
  "complete" | "empty" | "unauthorised" | "failed" | "partial" | "absent";
export type RecruitmentJson =
  | string
  | number
  | boolean
  | null
  | RecruitmentJson[]
  | { [key: string]: RecruitmentJson };
export type RecruitmentProvenance = {
  id: string;
  collector: string;
  method: string;
  toolVersion: string;
  sourceKind: "authenticated-esi" | "public-esi";
  transformations: string[];
};
export type RecruitmentDataset = {
  characterId: string;
  category: RecruitmentCategory;
  status: RecruitmentStatus;
  provenanceId: string;
  history: { knownLimit: string | null; earliestReturnedAt: string | null };
  note: string;
};
export type RecruitmentRecord = {
  id: string;
  characterId: string;
  category: RecruitmentCategory;
  provenanceId: string;
  sourceRecordId: string | null;
  data: { [key: string]: RecruitmentJson };
};
export type RecruitmentManifest = {
  version: 1;
  bundleId: string;
  revision: string;
  collectedAt: string;
  declaredCharacterIds: string[];
  includedCharacterIds: string[];
  provenance: RecruitmentProvenance[];
  datasets: RecruitmentDataset[];
};
export type RecruitmentExport = {
  format: "authgd-recruitment-evidence";
  version: 1;
  accountId: string;
  manifest: RecruitmentManifest;
  records: RecruitmentRecord[];
};
