import { request, type IncomingHttpHeaders } from "node:http";

/** Loopback HTTP, not Fetch: GET bytes and repeated framing lines must reach the
 * actual Node parser/Next adapter instead of being rejected by a client API. */
export function getFleetHttp(
  url: string,
  headers: Headers,
  framing: readonly string[] = [],
  body = "",
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(target.hostname)
  )
    throw new Error("fleet HTTP test requires loopback");
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: "GET",
        agent: false,
        signal: AbortSignal.timeout(5000),
        headers: ["Host", target.host, ...Array.from(headers).flat(), ...framing],
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
