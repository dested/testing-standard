// The environment every command gets: an allowlist from the caller, plus
// gate's own vars. And a small .env reader, used only to find a database
// server (gate never loads the copied .env into the environment).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ALLOWED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TERM",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "BUN_INSTALL", "PLAYWRIGHT_BROWSERS_PATH",
  "WSL_DISTRO_NAME", "WSL_INTEROP",
] as const;

export type Env = Record<string, string>;

/** The allowlisted part of `caller`, plus every name in `pass`. */
export function baseEnv(caller: NodeJS.ProcessEnv, pass: string[]): Env {
  const env: Env = {};
  for (const name of [...ALLOWED_ENV, ...pass]) {
    const v = caller[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}

/** KEY=value lines; `export`, quotes and comments handled the way dotenv does. */
export function parseDotenv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m?.[1]) continue;
    let v = (m[2] ?? "").trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v.length > 1 && v.endsWith(q)) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, "\n");
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    vars.set(m[1], v);
  }
  return vars;
}

/** Every value set in the working tree's copy.env files (for masking output). */
export function envFileValues(top: string, files: string[]): string[] {
  const values: string[] = [];
  for (const f of files) {
    const p = join(top, f);
    if (!existsSync(p)) continue;
    try {
      for (const v of parseDotenv(readFileSync(p, "utf8")).values()) values.push(v);
    } catch {
      // unreadable: nothing to mask from it
    }
  }
  return values;
}

/** A var from the caller's env, else the first copy.env file that defines it. */
export function lookupVar(caller: NodeJS.ProcessEnv, top: string, files: string[], name: string): { value: string; from: string } | null {
  const own = caller[name];
  if (own) return { value: own, from: "the environment" };
  for (const f of files) {
    const p = join(top, f);
    if (!existsSync(p)) continue;
    const v = parseDotenv(readFileSync(p, "utf8")).get(name);
    if (v) return { value: v, from: f };
  }
  return null;
}
