import { VERSION } from "@earendil-works/pi-coding-agent";
import registerRecruitmentReview from "../skills/recruitment-review/scripts/pi-review.mjs";

export default function recruitmentReview(pi) {
  registerRecruitmentReview(pi, { hostVersion: VERSION });
}
