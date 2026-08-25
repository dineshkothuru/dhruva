/** Harness-owned Salesforce development standards — LLM-agnostic.
 *
 * Distilled from the team's ruleset (Salesforce-Copilot-Starter instructions).
 * Delivered deterministically by the ENGINE, never via vendor file
 * conventions: (1) injected verbatim into every agent step's prompt,
 * (2) the checkable subset enforced as post-change verification over the
 * actual changed files — catching violations regardless of which agent
 * (or human) wrote the code.
 */

export const STANDARDS_VERSION = "1";

/** Injected into every code-writing agent step. Keep tight — rules, not prose. */
export const STANDARDS_PROMPT = `SALESFORCE DEVELOPMENT STANDARDS (mandatory):
- Keep all source in SFDX structure under force-app/main/default/.
- Reuse existing services, selectors, helpers, and components before creating new artifacts. Never duplicate business logic that exists.
- Bulk-safe Apex always: no SOQL, DML, or callouts inside per-record loops.
- One trigger per object, thin trigger body, handler class for logic.
- Declare sharing explicitly on every Apex class ("with sharing" unless justified in a comment); enforce CRUD/FLS with WITH USER_MODE / AccessLevel.USER_MODE.
- Never build dynamic SOQL by concatenating user input; bind values or use Database.queryWithBinds.
- No broad exception swallowing or silent catch blocks; no success-shaped fallbacks on failure.
- Never hard-code record IDs, org URLs, usernames, profile names, or environment assumptions.
- No credentials, tokens, or secrets in code, tests, or metadata; use Named Credentials or protected custom metadata.
- Write or update tests for behavior changes; build data via the shared TestDataFactory when present; assertions must be meaningful with messages; no SeeAllData=true.
- @AuraEnabled / @RestResource methods must validate client input server-side.
- LWC: SLDS patterns, accessible markup, @salesforce/* imports.
- Every changed component's *-meta.xml stays in sync; permission set changes ship with the feature.
- Do not delete or rename classes, fields, objects, flows, or integration-facing API names unless explicitly requested.
- Never deploy, push, or run destructive CLI commands; the workflow's own gated steps handle deployment.
- Match the surrounding code style; comment only non-obvious intent.
- Report exactly what you did; never claim a validation you did not run.`;

export interface StandardsViolation {
  file: string;
  rule: string;
  severity: "error" | "warning";
  detail: string;
}

interface Check {
  rule: string;
  severity: "error" | "warning";
  /** Which changed files this check applies to. */
  files: RegExp;
  /** Violation when this matches the file content. */
  pattern: RegExp;
  detail: string;
}

const CHECKS: Check[] = [
  {
    rule: "no-seealldata",
    severity: "error",
    files: /\.cls$/i,
    pattern: /SeeAllData\s*=\s*true/i,
    detail: "SeeAllData=true in tests is forbidden — build data with TestDataFactory.",
  },
  {
    rule: "no-hardcoded-ids",
    severity: "error",
    files: /\.(cls|trigger|js)$/i,
    pattern: /['"](00[15DGQeE][0-9A-Za-z]{12}([0-9A-Za-z]{3})?)['"]/,
    detail: "Hard-coded Salesforce record/org ID — query or configure it instead.",
  },
  {
    rule: "no-secrets",
    severity: "error",
    files: /\.(cls|trigger|js|xml)$/i,
    pattern: /(password|client_?secret|api_?key|bearer\s+[A-Za-z0-9._-]{16,})\s*[:=]\s*['"][^'"]{6,}['"]/i,
    detail: "Looks like a credential/secret in source — use Named Credentials or protected custom metadata.",
  },
  {
    rule: "explicit-sharing-justification",
    severity: "warning",
    files: /\.cls$/i,
    pattern: /\bwithout\s+sharing\b/i,
    detail: "'without sharing' used — requires a stated justification comment and reviewer attention.",
  },
  {
    rule: "no-soql-in-loop",
    severity: "warning",
    files: /\.(cls|trigger)$/i,
    pattern: /for\s*\([^)]*\)\s*\{[^{}]*\[\s*SELECT\s/is,
    detail: "SOQL inside a loop (heuristic match) — bulkify: query before the loop.",
  },
  {
    rule: "no-dml-in-loop",
    severity: "warning",
    files: /\.(cls|trigger)$/i,
    pattern: /for\s*\([^)]*\)\s*\{[^{}]*\b(insert|update|delete|upsert)\s+\w/is,
    detail: "DML inside a loop (heuristic match) — collect records and perform one DML.",
  },
  {
    rule: "no-user-input-soql-concat",
    severity: "warning",
    files: /\.(cls|trigger)$/i,
    pattern: /Database\.query\s*\(\s*['"][^'"]*['"]\s*\+/i,
    detail: "Dynamic SOQL built by concatenation — bind values or Database.queryWithBinds.",
  },
];

/** Run the deterministic checks over changed files' current content.
 * Caller supplies file contents (engine reads them from the project). */
export function checkStandards(
  files: { file: string; content: string }[],
): StandardsViolation[] {
  const out: StandardsViolation[] = [];
  for (const f of files) {
    for (const c of CHECKS) {
      if (!c.files.test(f.file)) continue;
      if (c.pattern.test(f.content)) {
        out.push({ file: f.file, rule: c.rule, severity: c.severity, detail: c.detail });
      }
    }
  }
  return out;
}
