// Explicit, bounded Next HTTP exercise — not part of the fixed-port/full suite.
// Run with both owned test URLs. No request below is authorized for DB admission.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { request } from "node:http";
import { mkdir, readFile, writeFile, appendFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const notes = path.join(root, ".superpowers/sdd/fleet-v2-backend");
  assert.equal(process.cwd(), root);
  assert.equal(
    process.env.TEST_DATABASE_URL,
    "postgres://authgd:authgd@127.0.0.1:55462/authgd_test_fleet_v2_backend",
  );
  assert.equal(
    process.env.FLEET_LEGACY_TEST_DATABASE_URL,
    "postgres://authgd:authgd@127.0.0.1:55462/authgd_test_fleet_v2_backend_legacy_migration",
  );
  // OS-assigned NEW loopback port, inspected before starting our exact process.
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  assert(![3987, 3988, 5433, 55462].includes(port));
  const listeners = execFileSync("ss", ["-ltnp", `sport = :${port}`], {
    encoding: "utf8",
  });
  await new Promise<void>((resolve, reject) =>
    probe.close((err) => (err ? reject(err) : resolve())),
  );
  const fixture = path.join(notes, `framing-http-fixture-${process.pid}`);
  await mkdir(fixture, { recursive: true });
  const record = path.join(notes, "framing-http-resource.md");
  await appendFile(
    record,
    `\n## ${new Date().toISOString()}\n\nOwner PID ${process.pid}; NEW port ${port}; worktree ${root}.\nProbe exclusively bound and closed before Next start. Inspection:\n\n\`\`\`\n${listeners}\`\`\`\nFixture ${fixture}; no DB requests intended. Both owned 55462 URLs supplied.\n`,
  );
  const putFile = async (name: string, content: string) => {
    const target = path.join(fixture, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  await putFile("package.json", '{"private":true}');
  await putFile(
    "next.config.mjs",
    `export { default } from ${JSON.stringify(path.join(root, "next.config.ts"))};\n`,
  );
  await putFile(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        paths: { "@/*": [path.relative(fixture, path.join(root, "src/*"))] },
      },
    }),
  );
  // Next statically analyzes matcher literals; a re-export would not exercise
  // the production matcher. Copy exact bytes and retain their origin/hash.
  const proxyPath = path.join(root, "src/proxy.ts");
  const proxySource = await readFile(proxyPath, "utf8");
  await putFile("proxy.ts", proxySource);
  await appendFile(
    record,
    `Production Proxy copied from ${proxyPath}; SHA256 ${createHash("sha256").update(proxySource).digest("hex")}.\n`,
  );
  const paths = [
    "v1/catalogue",
    "v2/pairing-requests",
    "v2/pairing-requests/[id]/complete",
    "v2/recovery-challenges",
    "v2/recovery-challenges/[id]/complete",
    "v2/session",
  ];
  for (const route of paths) {
    await putFile(
      `app/api/fleet/${route}/route.ts`,
      `export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD, dynamic } from ${JSON.stringify(path.join(root, "src/app/api/fleet", route, "route.ts"))};\n`,
    );
  }
  const child = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/next/dist/bin/next"),
      "dev",
      fixture,
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const results: object[] = [];
  let failures = 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await appendFile(
      record,
      `Next CLI PID ${child.pid}; argv next dev ${fixture} --webpack --hostname 127.0.0.1 --port ${port}.\n`,
    );
    const deadline = Date.now() + 90000;
    while (!output.includes("Ready in")) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Next not ready: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await appendFile(
      record,
      `Listener/process inspection after Ready:\n\n\`\`\`\n${execFileSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" })}\`\`\`\n`,
    );
    const id = "11111111-1111-4111-8111-111111111111";
    const cases = [
      ...[
        "pairing-requests",
        `pairing-requests/${id}/complete`,
        "recovery-challenges",
        `recovery-challenges/${id}/complete`,
      ].flatMap((suffix) => [
        {
          url: `/api/fleet/v2/${suffix}/`,
          method: "POST",
          status: 400,
          error: "bad_request",
        },
        {
          url: `/api/fleet/v2/${suffix}`,
          method: "POST",
          status: 400,
          error: "bad_request",
        },
      ]),
      {
        url: "/api/fleet/v1/catalogue/",
        method: "POST",
        status: 400,
        error: "update_required",
      },
      {
        url: "/api/fleet/v1/catalogue/",
        method: "HEAD",
        status: 400,
        error: "update_required",
      },
      { url: "/api/fleet/v2/session/", method: "PUT", status: 400, error: "bad_request" },
      ...[
        "/account/?tab=one",
        "/api/other/",
        "/api/fleetish/",
        "/file.txt/",
        "/_next/image/",
        "/_next/image/?url=%2Flogo.png&w=64&q=75",
        "/_next/static/chunks/missing.js/",
        "/_nextfoo/",
        "/_nextfoo/?_rsc=opaque",
        "/_next/",
        "/_NeXtfoo/",
        "/_next/static/chunks/%E2%82%AC%20name.js/?q=space%20value&mark=~&tag=a&tag=b",
      ].map((url) => ({ url, method: "GET", status: 308, error: undefined })),
      ...[
        "/_next/image/?url=%2Flogo.png&w=64&q=75",
        "/_next/static/chunks/missing.js/?v=one",
        "/_nextfoo/?v=one",
      ].map((url) => ({ url, method: "HEAD", status: 308, error: undefined })),
      ...[
        { url: "/_next/image", method: "GET", status: 400 },
        { url: "/_next/image?url=%2Flogo.png&w=64&q=75", method: "HEAD", status: 400 },
        { url: "/_next/static/chunks/missing.js", method: "GET", status: 404 },
        { url: "/_nextfoo", method: "GET", status: 404 },
      ].map((item) => ({ ...item, error: undefined })),
    ];
    for (const item of cases) {
      const preSessionTrailing =
        item.method === "POST" &&
        item.url.startsWith("/api/fleet/v2/") &&
        item.url.endsWith("/");
      const bodyInput = item.url.includes("/recovery-challenges/")
        ? item.url.includes("/complete/")
          ? { protocol: 2, nonce: "A".repeat(43), recovery_signature: "A".repeat(86) }
          : {
              protocol: 2,
              public_key_spki_b64url: "AA",
              request_id: "A".repeat(43),
              issued_at: "2026-09-16T00:00:00.000Z",
              initiation_signature: "A".repeat(86),
            }
        : item.url.includes("/complete/")
          ? { protocol: 2, completion_signature: "A".repeat(86) }
          : { protocol: 2, public_key_spki_b64url: "AA", requested_capabilities: [] };
      const response = await fetch(base + item.url, {
        method: item.method,
        redirect: "manual",
        signal: AbortSignal.timeout(60000),
        ...(preSessionTrailing
          ? {
              headers: { "X-Fleet-Attempt": "A".repeat(43) },
              body: JSON.stringify(bodyInput),
            }
          : {}),
      });
      const body = await response.text();
      const result = {
        ...item,
        actual: response.status,
        location: response.headers.get("location"),
        cache: response.headers.get("cache-control"),
        body,
      };
      results.push(result);
      try {
        assert.equal(response.status, item.status);
        if (item.method === "HEAD") assert.equal(body, "");
        if (item.status === 308) {
          assert.equal(
            response.headers.get("location"),
            item.url.replace(/\/(?=\?|$)/, ""),
          );
        } else if (item.error === undefined) {
          // Missing assets/image arguments are handled normally, not redirected.
          assert.equal(response.headers.get("location"), null);
        } else {
          assert.equal(response.headers.get("location"), null);
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.equal(
            body,
            item.method === "HEAD"
              ? ""
              : JSON.stringify({ protocol: 2, error: item.error }),
          );
        }
      } catch (error) {
        failures++;
        console.error({ ...result, body: body.slice(0, 160) }, String(error));
      }
    }
    // node:http preserves a literal backslash request target; fetch/WHATWG URL
    // would normalize it at the CLIENT and produce misleading server evidence.
    for (const raw of [
      "/api/fleet//v2/pairing-requests",
      "/api/fleet\\v2/pairing-requests",
    ]) {
      const result = await new Promise<object>((resolve, reject) => {
        const req = request(
          { hostname: "127.0.0.1", port, path: raw, method: "POST" },
          (res) => {
            let body = "";
            res.on("data", (data) => {
              body += data;
            });
            res.on("end", () =>
              resolve({
                raw,
                status: res.statusCode,
                location: res.headers.location,
                cache: res.headers["cache-control"],
                body,
              }),
            );
          },
        );
        req.on("error", reject);
        req.setTimeout(10000, () => req.destroy(new Error("raw HTTP timeout")));
        req.end();
      });
      results.push(result);
    }
  } finally {
    child.kill("SIGTERM");
    const outcome = await exited;
    await writeFile(path.join(fixture, "next.log"), output);
    await writeFile(
      path.join(fixture, "results.json"),
      JSON.stringify(results, null, 2) + "\n",
    );
    const after = execFileSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" });
    await appendFile(
      record,
      `Stopped exact Next CLI PID ${child.pid} with SIGTERM and awaited exit ${JSON.stringify(outcome)}.\nAfter-stop listener inspection:\n\n\`\`\`\n${after}\`\`\`\nResults: ${path.join(fixture, "results.json")}; log: ${path.join(fixture, "next.log")}.\n`,
    );
    assert(!after.includes("LISTEN"), "owned Next listener must be gone");
    // Keep evidence, not generated application/type/compiler files in lint scope.
    for (const entry of await readdir(fixture)) {
      if (entry !== "next.log" && entry !== "results.json")
        await rm(path.join(fixture, entry), { recursive: true, force: true });
    }
    console.log(
      JSON.stringify(
        {
          fixture,
          port,
          failures,
          results: results.map((r) => ({
            ...r,
            body: String((r as { body?: string }).body).slice(0, 160),
          })),
        },
        null,
        2,
      ),
    );
  }
  assert.equal(failures, 0, "actual Next fleet framing assertions");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
