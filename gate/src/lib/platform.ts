// Where gate runs and how it names paths for the person reading them. In WSL, a
// path gate prints or opens is given in its Windows form, because the browser
// and the editor run on Windows. Path rules: `/w/x` → `W:\x` (W: is a subst of
// the distro's /w), `/mnt/c/x` → `C:\x`, any other `/x` → `\\wsl.localhost\<distro>\x`.

import { existsSync } from "node:fs";

/** The distro gate runs in, as WSL names it. */
const WSL_DISTRO = process.env.WSL_DISTRO_NAME || "sal";

/** True inside WSL, where Windows binaries run through interop. */
export function isWsl(): boolean {
  return process.platform === "linux" && (Boolean(process.env.WSL_DISTRO_NAME) || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop"));
}

/** `/w/code/x` → `W:\code\x`; `/mnt/g/x` → `G:\x`; any other distro path → `\\wsl.localhost\<distro>\x`. */
export function linuxToWin(p: string): string {
  const w = /^\/w(?:\/(.*))?$/.exec(p);
  if (w) return `W:\\${(w[1] ?? "").replace(/\//g, "\\")}`;
  const mnt = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  if (mnt?.[1]) return `${mnt[1].toUpperCase()}:\\${(mnt[2] ?? "").replace(/\//g, "\\")}`;
  return `\\\\wsl.localhost\\${WSL_DISTRO}${p.replace(/\//g, "\\")}`;
}

/**
 * The scratch twin of a project folder: `/w/code/<repo>` → `/w/junk/<repo>`,
 * where gate keeps its clean copy on a machine laid out that way. Null for any
 * other path (gate then uses `$GATE_WORK` or the temp folder).
 */
export function junkTwin(path: string): string | null {
  const m = /^\/w\/code\/([^/]+)\/?$/.exec(path);
  return m?.[1] ? `/w/junk/${m[1]}` : null;
}
