---
applyTo: "force-app/main/default/**/*"
---

Global Salesforce engineering standards (applies to all metadata and code):

- Follow clear naming conventions:
  - Apex classes/components: `PascalCase`
  - Methods/variables/properties: `camelCase`
  - Constants: `UPPER_SNAKE_CASE`
  - LWC folders/bundles: `camelCase`
- Prefer reusable services, helpers, selectors, and UI components before creating new duplicate logic.
- Keep changes minimal, intentional, and deploy-safe; avoid unrelated refactors.
- Keep logic deterministic, testable, and bulk-safe; avoid hidden side effects.
- Enforce security by design: sharing model, CRUD/FLS, and least-privilege access.
- Preserve backward compatibility for existing integrations, automations, and user flows unless a breaking change is explicitly requested.
- Validate cross-metadata references whenever identifiers or contracts change.
- Add or update the nearest relevant tests for behavior changes.
- Avoid hard-coded org/environment-specific values (IDs, URLs, profile names) unless explicitly required.
- Write code in the same style as surrounding repository code so it reads as naturally authored by the team.
- Avoid AI-signature patterns (over-verbose scaffolding, repetitive boilerplate, generic placeholder naming).
- Use concise, practical comments only when needed to explain non-obvious intent or business rules.
- Do not add comments that restate obvious code behavior.
- Keep prose and comments plain and professional; avoid em dashes.

Scope boundaries:

- Keep this file as the non-negotiable baseline.
- Put architecture decisions in `salesforce-design-standards.instructions.md`.
- Put access control and injection safety in `salesforce-security.instructions.md`.
- Put completion and release gates in `pr-readiness.instructions.md`.
- Put org and CLI command safety in `salesforce-agent-safety.instructions.md`.
- Keep technology-specific details in the Apex, LWC, flow, schema, and metadata instruction files.
- Scope any new instruction file with the narrowest `applyTo` that works; everything scoped to all of `force-app` loads on every request.
