/**
 * Per-tab spend budget enforcement, extracted from TabManager.
 *
 * Pure function (with a tiny stateful wrapper) so it can be unit-tested without
 * a database or a running subprocess: feed in current spend + tab name, get a
 * decision back. The caller (TabManager.executeMessage) handles the side
 * effects (notify + early return).
 */

export interface BudgetDecision {
  allowed: boolean;
  /** When allowed=false, the message to surface to the caller. */
  reason?: string;
  /** When the tab has crossed the 80% threshold, the warning text to notify. */
  warning?: string;
}

export class BudgetGuard {
  constructor(private maxBudgetUsd: number | undefined) {}

  check(currentSpend: number, tabName: string): BudgetDecision {
    if (!this.maxBudgetUsd) return { allowed: true };
    if (currentSpend >= this.maxBudgetUsd) {
      return {
        allowed: false,
        reason: `Budget limit reached for tab "${tabName}": $${currentSpend.toFixed(2)} / $${this.maxBudgetUsd.toFixed(2)}`,
      };
    }
    if (currentSpend >= this.maxBudgetUsd * 0.8) {
      return {
        allowed: true,
        warning: `⚠️ Budget warning: tab "${tabName}" at $${currentSpend.toFixed(2)} / $${this.maxBudgetUsd.toFixed(2)} (80%)`,
      };
    }
    return { allowed: true };
  }
}
