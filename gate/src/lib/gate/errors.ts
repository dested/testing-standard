// Exit codes are the contract an agent reads (gate-contract.md "Exit codes"):
// 1 = the commit is red, 2 = usage or gate.json, 3 = gate itself couldn't run.

export const EXIT = { pass: 0, red: 1, usage: 2, broken: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure that ends the command with a specific exit code. The message says what to do next. */
export class GateError extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
  ) {
    super(message);
  }
}

export function usage(message: string): GateError {
  return new GateError(EXIT.usage, message);
}

export function broken(message: string): GateError {
  return new GateError(EXIT.broken, message);
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
