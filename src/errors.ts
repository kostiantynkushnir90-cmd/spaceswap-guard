import type { GuardIssue } from "./types";

// Thrown by the pre-sign pipeline when any guard issue has level "block": the swap stops before
// the wallet is ever asked to sign, so a blocked attempt costs the user nothing.
export class SwapGuardError extends Error {
  readonly issues: GuardIssue[];

  constructor(issues: GuardIssue[]) {
    super(issues.find((issue) => issue.level === "block")?.message ?? "Swap blocked by guard rules.");
    this.name = "SwapGuardError";
    this.issues = issues;
  }
}
