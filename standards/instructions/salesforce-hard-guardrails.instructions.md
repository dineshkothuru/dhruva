---
applyTo: "force-app/main/default/**/*"
---

Salesforce hard guardrails (strict):

Approval-required changes:

- Do not delete or rename Apex classes, triggers, LWCs, objects, fields, flows, or integration-facing API names unless explicitly requested.
- Do not change sharing model behavior, permission model scope, or sensitive field exposure without explicit request.
- Do not introduce breaking changes to integration contracts unless explicitly requested and versioned.
- Do not remove metadata targets/capabilities/visibility settings without explicit request.

Forbidden implementation patterns:

- No SOQL or DML inside per-record loops.
- No dynamic SOQL built by concatenating user input; bind values or use `Database.queryWithBinds`.
- No broad exception swallowing, silent catch blocks, or success-shaped fallbacks on failure.
- No hard-coded org-specific IDs, URLs, usernames, profile names, or environment assumptions.
- No credentials, tokens, or secrets in code, tests, or metadata; use Named Credentials or protected custom metadata.
- No duplicated business logic when reusable service/helper/component alternatives exist.
- No bypass of CRUD/FLS or sharing checks for user-context data operations.
- No `@AuraEnabled` or `@RestResource` method that trusts client input without server-side validation.
- No `without sharing` or `SYSTEM_MODE` usage without a stated justification.
- No `SeeAllData=true` in tests unless the feature genuinely requires it.

Required delivery checks:

- Run targeted validations for touched behavior (Apex tests and LWC tests where applicable).
- Ensure changed metadata is deployable as a coherent unit with dependencies.
- Verify backward compatibility for user flows, automation, and integrations unless breaking change is requested.
- Never deploy, push, or run destructive CLI commands against an org without an explicit request; see `salesforce-agent-safety.instructions.md`.
- Confirm comments are minimal, human-like, and only for non-obvious intent.
