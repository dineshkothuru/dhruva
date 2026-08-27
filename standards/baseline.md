# Team Standards for This Salesforce DX Repository

Follow Salesforce-first patterns and keep changes production-safe.

This file is the shared baseline. Detailed, enforceable standards are the scoped modules the harness includes alongside it in this prompt.

`force-app/main/default/` is intentionally empty in the baseline. Teams retrieve their own org metadata into it. Until the repository has code of its own to imitate, follow the layering and examples in `docs/reference-patterns.md`.

## Core standards

- Keep all source in SFDX structure under `force-app/main/default/`.
- Reuse existing services, selectors, helpers, and components before creating new artifacts.
- Use bulk-safe patterns in Apex and triggers: no SOQL, DML, or callouts in per-record loops.
- Prefer one trigger per object with handler-based logic and a thin trigger body.
- Declare sharing explicitly on every Apex class, and enforce CRUD/FLS with `WITH USER_MODE` and `AccessLevel.USER_MODE`.
- Never build dynamic SOQL from unbound user input.
- Keep Apex methods small and testable; extract business logic into service and domain classes.
- Write or update tests for behavior changes, building data through the shared `TestDataFactory` and keeping assertions meaningful, with messages.
- For LWC, use SLDS patterns, accessible markup, and `@salesforce/*` imports.
- Keep naming clear and aligned with Salesforce metadata conventions.
- Never hard-code IDs, URLs, profile names, or secrets.

## Validation expectations

- Run targeted validations first: Apex tests for changed classes, `npm run test:unit` for changed LWC.
- Report exactly which commands were run and their result; never claim validation that was not performed.
- Avoid broad refactors unless explicitly requested.
- Preserve metadata consistency; `*-meta.xml` files must stay in sync with source, and permission set changes ship with the feature.

## Org safety

- Never deploy, push, or run destructive Salesforce CLI commands against an org unless explicitly asked.
- Prefer `sf project deploy validate` (or `sf project deploy start --dry-run`) when deployability must be proven. Note that `sf project deploy validate` has no `--dry-run` flag.
- Never assume the default org is a sandbox; it may be production.

## Working style

- Write code in the same style as surrounding repository code.
- Avoid over-generated boilerplate and generic placeholder naming.
- Comment only non-obvious intent or business rules.
