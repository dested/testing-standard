// Human output: plain, stable, no spinner (agents read it). Every printed line
// goes through the scrubber, so a database password or a value from a copied
// env file never reaches the terminal even when a check prints it.

export type OutMode = "human" | "quiet" | "json";

export class Scrubber {
  private secrets: string[] = [];

  add(...values: string[]): void {
    for (const v of values) {
      // Short values ("1", "true", a port) would mask half the log; they aren't secrets.
      if (v && v.length >= 6 && !this.secrets.includes(v)) this.secrets.push(v);
    }
    this.secrets.sort((a, b) => b.length - a.length);
  }

  scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("***");
    return out;
  }
}

export class Out {
  private buffered: string[] = [];

  constructor(
    readonly mode: OutMode,
    readonly scrubber: Scrubber,
  ) {}

  /** A line of the run's report. Quiet mode holds it until we know the run failed. */
  line(text = ""): void {
    const s = this.scrubber.scrub(text);
    if (this.mode === "human") console.log(s);
    else if (this.mode === "quiet") this.buffered.push(s);
  }

  /** Raw check output for --verbose (stderr under --json, so stdout stays one object). */
  stream(text: string): void {
    const s = this.scrubber.scrub(text);
    if (this.mode === "json") process.stderr.write(`${s}\n`);
    else console.log(s);
  }

  /** Quiet mode: the run failed, so show what was held back. */
  flush(): void {
    if (this.mode === "quiet") for (const l of this.buffered) console.log(l);
    this.buffered = [];
  }
}

export function fmtMs(ms: number): string {
  const s = ms / 1000;
  if (s < 100) return `${s.toFixed(1)}s`;
  if (s < 600) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export type LineStatus = "pass" | "FAIL" | "skip";

/** `pass  setup    1.2s   61 tests` */
export function checkLine(status: LineStatus, name: string, width: number, ms: number | null, detail?: string): string {
  const tag = status === "skip" ? " -- " : status;
  const time = ms === null ? "" : fmtMs(ms).padStart(6);
  const head = `${tag}  ${name.padEnd(width)}`;
  if (ms === null) return `${head}    ${detail ?? "not run"}`;
  return `${head}  ${time}${detail ? `   ${detail}` : ""}`;
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}
