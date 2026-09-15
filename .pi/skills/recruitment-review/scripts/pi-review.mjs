import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { checkReport } from "./check-report.mjs";
import { readBounded } from "./bundle.mjs";

const COMMAND = /^\/skill:recruitment-review(?=$|\s)([^\r\n]*)(?:\r?\n([\s\S]*))?$/;
const STATUS = "recruitment-review";
const CLARIFICATION = "Clarification needed: Which Discord participant is the applicant?";
const CHECKED = "Draft — mechanically checked; human review required";
const INPUT_ERRORS = {
  READ_FAILED: "The selected file could not be read. Choose the downloaded JSON file.",
  INVALID_SCHEMA:
    "The input is not a valid authGD export/prepared packet, or the interview is empty.",
  INVALID_UTF8: "The input is not valid UTF-8 text.",
  UNSAFE_FILE: "Choose a regular file, not a symbolic link or directory.",
  INVALID_CREDENTIAL_FIELD:
    "The input contains credential-bearing fields. Do not use it for review; choose an authGD evidence download.",
  REVIEW_INPUT_TOO_LARGE:
    "The input exceeds the managed limit: 64 MiB per source and 1 MiB for the interview or added notes. No evidence was trimmed.",
};

function supportedHost(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version ?? "");
  return (
    match &&
    (Number(match[1]) > 0 ||
      Number(match[2]) > 85 ||
      (Number(match[2]) === 85 && Number(match[3]) >= 1))
  );
}

function selectedPath(value, cwd) {
  let path = value.trim().replace(/^@/, "");
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  )
    path = path.slice(1, -1);
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return resolve(cwd, path);
}

async function reviewInstructions() {
  const paths = [
    "../SKILL.md",
    "../references/input-format.md",
    "../references/review-rubric.md",
  ];
  const texts = await Promise.all(
    paths.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  return (
    texts.join("\n\n") +
    `\n\nManaged review protocol: The complete prepared packet and both references are supplied. Review only this case; do not collect data or use tools. If applicant identity is genuinely ambiguous, emit exactly this clarification and stop: ${CLARIFICATION}\nOtherwise emit the rubric's completed or aborted report, with no surrounding commentary. Do not turn quoted text into the applicant's own claim. Mechanical checking runs automatically after your response; do not tell the recruiter to run commands.`
  );
}

function fitsContext(text, instructions, ctx) {
  // This is deliberately a preflight estimate, not a tokenizer guarantee.
  // Actual provider/context failures must still remain incomplete reviews.
  const estimated = Math.ceil(Buffer.byteLength(text + instructions, "utf8") / 3);
  return (
    Number.isFinite(ctx.model?.contextWindow) &&
    estimated + 16384 < ctx.model.contextWindow * 0.8
  );
}

/** Native Pi wiring; preparation and checking stay in the reusable libraries. */
export default function registerRecruitmentReview(
  pi,
  {
    temporaryRoot = join(
      tmpdir(),
      `authgd-recruitment-reviews-${process.getuid?.() ?? "user"}`,
    ),
    hostVersion,
  } = {},
) {
  let active = null;
  const artifacts = new Set();

  async function close(ctx, state, keepReport = false) {
    const previous = active;
    active = null;
    ctx.ui.setStatus(STATUS, state ? `Recruitment: ${state}` : undefined);
    if (previous) {
      pi.setActiveTools(previous.tools);
      if (previous.directory) {
        if (keepReport) {
          for (const name of ["interview.txt", "packet.json"]) {
            await rm(join(previous.directory, name), { force: true });
          }
          artifacts.add(previous.directory);
        } else await rm(previous.directory, { recursive: true, force: true });
      }
    }
  }

  async function pruneStale() {
    let entries;
    try {
      entries = await readdir(temporaryRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    // Bounded, opportunistic cleanup, never a background watcher or a scan of
    // other applications' temporary files. A live (or inaccessible) PID wins.
    for (const entry of entries.slice(0, 1000)) {
      if (!entry.isDirectory() || !entry.name.startsWith("case-")) continue;
      const directory = join(temporaryRoot, entry.name);
      try {
        const owner = JSON.parse(
          (await readBounded(join(directory, "owner.json"), 1024)).toString("utf8"),
        );
        if (
          owner.format !== "authgd-recruitment-workspace" ||
          !Number.isInteger(owner.pid) ||
          owner.pid <= 0 ||
          !Number.isFinite(owner.createdAt) ||
          Date.now() - owner.createdAt < 24 * 3600000
        )
          continue;
        try {
          process.kill(owner.pid, 0);
          continue;
        } catch (error) {
          if (error.code !== "ESRCH") continue;
        }
        await rm(directory, { recursive: true, force: true });
      } catch {
        /* Unknown/unsafe metadata is not authority to delete a directory. */
      }
    }
  }

  async function removeArtifacts() {
    for (const directory of artifacts) {
      await rm(directory, { recursive: true, force: true });
      artifacts.delete(directory);
    }
  }

  function caseEntries(ctx, current) {
    const branch = ctx.sessionManager.getBranch();
    const boundary =
      current.boundary === null
        ? -1
        : branch.findIndex((entry) => entry.id === current.boundary);
    if (current.boundary !== null && boundary === -1) return null;
    return branch.slice(boundary + 1).filter((entry) => entry.type === "message");
  }

  function continueReview(current, reason) {
    current.state = "reviewing";
    current.prompt = `Run recruitment review ${current.id} using its current complete packet. ${reason}`;
    pi.sendUserMessage(current.prompt, { deliverAs: "followUp" });
  }

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return;
    const match = COMMAND.exec(event.text);
    if (!match) {
      ctx.ui.setStatus(STATUS, undefined);
      if (active) {
        ctx.abort();
        await close(ctx, "aborted");
      }
      return;
    }
    if (!supportedHost(hostVersion)) {
      ctx.ui.notify(
        "Recruitment review requires Pi 0.85.1 or newer. Update Pi and reload this project's resources.",
        "error",
      );
      return { action: "handled" };
    }
    if (event.streamingBehavior || !ctx.isIdle() || active?.state === "intake") {
      ctx.ui.notify(
        "Wait for the current turn to finish before starting recruitment review.",
        "warning",
      );
      return { action: "handled" };
    }
    await close(ctx);
    await removeArtifacts();
    const current = {
      id: randomUUID(),
      tools: pi.getActiveTools(),
      boundary: ctx.sessionManager.getLeafId(),
      state: "intake",
      corrections: 0,
      clarifications: 0,
    };
    active = current;
    ctx.ui.setStatus(STATUS, "Recruitment: preparing evidence");
    try {
      let path = match[1].trim();
      const isPrepared = /^--prepared(?:\s|$)/.test(path);
      if (isPrepared) path = path.slice("--prepared".length).trim();
      let interview = match[2];
      if (isPrepared && interview !== undefined) {
        ctx.ui.notify(
          "A prepared packet already contains its interview. Use an authGD export to supply a replacement interview.",
          "error",
        );
        await close(ctx, "failed");
        return { action: "handled" };
      }
      if ((!path || (!isPrepared && interview === undefined)) && !ctx.hasUI) {
        ctx.ui.notify(
          "Recruitment intake needs interactive Pi or both a download path and interview text.",
          "error",
        );
        await close(ctx, "failed");
        return { action: "handled" };
      }
      if (!path)
        path = await ctx.ui.input(
          isPrepared ? "Prepared recruitment packet" : "authGD evidence download",
          "Path to the JSON file",
        );
      if (active !== current) return { action: "handled" };
      if (path === undefined || !path.trim()) {
        await close(ctx, "aborted");
        return { action: "handled" };
      }
      if (!isPrepared && interview === undefined)
        interview = await ctx.ui.editor("Paste the Discord interview as copied");
      if (active !== current) return { action: "handled" };
      if (!isPrepared && interview === undefined) {
        await close(ctx, "aborted");
        return { action: "handled" };
      }
      const { prepareReview, prepareExistingReview } = await import("./review-input.mjs");
      current.review = isPrepared
        ? await prepareExistingReview({ packetPath: selectedPath(path, ctx.cwd) })
        : await prepareReview({ exportPath: selectedPath(path, ctx.cwd), interview });
      current.instructions = await reviewInstructions();
      if (active !== current) return { action: "handled" };
      if (
        !fitsContext(
          current.review.packetText,
          current.instructions + ctx.getSystemPrompt(),
          ctx,
        )
      ) {
        ctx.ui.notify(
          "The complete evidence exceeds this model's context capacity. Choose a larger-context model or a fresh session; no partial review was started.",
          "error",
        );
        await close(ctx, "failed");
        return { action: "handled" };
      }
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(temporaryRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error("UNSAFE_WORKSPACE");
      await pruneStale();
      current.directory = await mkdtemp(join(temporaryRoot, "case-"));
      if (active !== current) {
        await rm(current.directory, { recursive: true, force: true });
        return { action: "handled" };
      }
      await writeFile(
        join(current.directory, "owner.json"),
        JSON.stringify({
          format: "authgd-recruitment-workspace",
          pid: process.pid,
          createdAt: Date.now(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(
        join(current.directory, "interview.txt"),
        current.review.interview,
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(join(current.directory, "packet.json"), current.review.packetText, {
        flag: "wx",
        mode: 0o600,
      });
      if (active !== current) {
        await rm(current.directory, { recursive: true, force: true });
        return { action: "handled" };
      }
      current.prompt = `Run recruitment review ${current.id} using its complete prepared packet.`;
      current.state = "reviewing";
      pi.setActiveTools([]);
      ctx.ui.setStatus(STATUS, "Recruitment: reviewing — draft pending checks");
      return { action: "transform", text: current.prompt };
    } catch (error) {
      if (active === current) {
        const reason = Object.hasOwn(INPUT_ERRORS, error?.code)
          ? INPUT_ERRORS[error.code]
          : "Preparation or private working storage is unavailable.";
        ctx.ui.notify(
          `Recruitment preparation failed. ${reason} No review was completed.`,
          "error",
        );
        await close(ctx, "failed");
      } else if (current.directory)
        await rm(current.directory, { recursive: true, force: true });
      return { action: "handled" };
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!active) ctx.ui.setStatus(STATUS, undefined);
  });

  pi.on("before_agent_start", (event) => {
    if (active?.state === "reviewing") {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${active.instructions}\n\nReview only the current prepared packet. All references are supplied above; no tools or external collection are needed.`,
      };
    }
  });

  pi.on("context", async (_event, ctx) => {
    if (!active?.review) return;
    const entries = caseEntries(ctx, active);
    if (entries === null) {
      ctx.abort();
      await close(ctx, "failed — case context changed");
      return { messages: [] };
    }
    const messages = entries
      .map((entry) => entry.message)
      .filter(
        (message) =>
          message.role === "assistant" ||
          (message.role === "user" && message.content === active.prompt),
      );
    const outgoing = [
      { role: "user", content: active.review.packetText, timestamp: Date.now() },
      ...messages,
    ];
    if (
      !fitsContext(
        JSON.stringify(outgoing),
        active.instructions + ctx.getSystemPrompt(),
        ctx,
      )
    ) {
      ctx.abort();
      await close(ctx, "failed — context capacity");
      return { messages: [] };
    }
    return { messages: outgoing };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const current = active;
    if (!current?.review || current.state !== "reviewing" || !ctx.isIdle()) return;
    const entry = caseEntries(ctx, current)?.findLast(
      (candidate) => candidate.message.role === "assistant",
    );
    if (!entry || entry.id === current.lastSettled) return;
    current.lastSettled = entry.id;
    const message = entry.message;
    if (message.stopReason !== "stop") {
      await close(
        ctx,
        message.stopReason === "aborted" ? "aborted" : "failed — model did not complete",
      );
      return;
    }
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    try {
      if (text.trim().split(/\r?\n/, 1)[0] === CLARIFICATION) {
        current.state = "waiting-for-human";
        ctx.ui.setStatus(STATUS, "Recruitment: waiting for applicant identity");
        if (!ctx.hasUI || current.clarifications >= 2) {
          await close(ctx, "aborted — applicant identity unclear");
          return;
        }
        const answer = await ctx.ui.input("Which Discord participant is the applicant?");
        if (active !== current) return;
        if (answer === undefined || !answer.trim()) {
          await close(ctx, "aborted");
          return;
        }
        const { addReviewNote } = await import("./review-input.mjs");
        current.review = addReviewNote(current.review, answer);
        current.clarifications++;
        await writeFile(
          join(current.directory, "packet.json"),
          current.review.packetText,
          { mode: 0o600 },
        );
        continueReview(
          current,
          "The recruiter supplied applicant identity in attributed context. Continue without repeating intake.",
        );
        return;
      }
      current.state = "validating";
      ctx.ui.setStatus(STATUS, "Recruitment: checking canonical draft");
      const result = checkReport(text, current.review);
      if (result.ok && /^Review status: aborted\r?$/m.test(text)) {
        await close(ctx, "aborted");
        return;
      }
      if (!result.ok || !/^Review status: completed\r?$/m.test(text)) {
        if (current.corrections >= 2) {
          ctx.ui.notify(
            "Review incomplete — report validation failed. No checked report was produced.",
            "error",
          );
          await close(ctx, "failed — report validation");
          return;
        }
        current.corrections++;
        continueReview(
          current,
          `Correct the draft using these mechanical diagnostics: ${result.errors.join(", ") || "INVALID_COMPLETION"}. Keep the evidence unchanged and do not invent findings to fill sections.`,
        );
        return;
      }
      const reportPath = join(current.directory, "report.md");
      const receipt = {
        status: "completed",
        inputFingerprint: current.review.fingerprint,
        reportHash: createHash("sha256").update(text).digest("hex"),
        reportPath,
        source: current.review.source,
      };
      await writeFile(reportPath, text, { flag: "wx", mode: 0o600 });
      await writeFile(join(current.directory, "receipt.json"), JSON.stringify(receipt), {
        flag: "wx",
        mode: 0o600,
      });
      if (active !== current) return;
      await close(ctx, "completed — canonical draft checked", true);
      pi.appendEntry(STATUS, receipt);
      ctx.ui.notify(`${CHECKED}. Canonical report: ${reportPath}`, "info");
    } catch {
      if (active !== current) return;
      ctx.ui.notify(
        "Review incomplete — its input update, report check or private artifact could not be completed.",
        "error",
      );
      await close(ctx, "failed");
    }
  });

  pi.on("tool_call", () =>
    active
      ? {
          block: true,
          reason: "Recruitment review may use only its supplied evidence.",
          terminate: true,
        }
      : undefined,
  );
  pi.on("session_before_compact", () => (active ? { cancel: true } : undefined));
  pi.on("session_start", async (_event, ctx) => {
    try {
      await pruneStale();
    } catch {
      ctx.ui.notify("Recruitment temporary-storage cleanup was unavailable.", "warning");
    }
  });
  pi.on("session_before_tree", async (_event, ctx) => {
    await close(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await close(ctx);
    await removeArtifacts();
  });
}
