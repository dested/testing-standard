// A distinct free TCP port per `ports[]` name, free on both 127.0.0.1 and ::1.

import { createServer } from "node:net";

function listen(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT" ? port : null));
    s.listen({ host, port, exclusive: true }, () => {
      const addr = s.address();
      const got = addr && typeof addr === "object" ? addr.port : null;
      s.close(() => resolve(got));
    });
  });
}

/** One free port on both stacks (no IPv6 on the box counts as free there). */
async function freePort(taken: Set<number>): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = await listen("127.0.0.1", 0);
    if (p === null || taken.has(p)) continue;
    if ((await listen("::1", p)) === p) return p;
  }
  throw new Error("couldn't find a free TCP port on 127.0.0.1 and ::1");
}

export async function allocatePorts(names: string[]): Promise<Record<string, string>> {
  const taken = new Set<number>();
  const out: Record<string, string> = {};
  for (const n of names) {
    const p = await freePort(taken);
    taken.add(p);
    out[n] = String(p);
  }
  return out;
}
