---
applyTo: "force-app/main/default/classes/**/*.cls"
roles: "implement, review"
---

When editing Salesforce Apex classes:

- Declare sharing explicitly on every class; use `with sharing` for user-context entry points and `inherited sharing` for reusable services.
- Enforce CRUD/FLS on user-driven data access using `WITH USER_MODE` on SOQL and `AccessLevel.USER_MODE` on DML.
- Never build SOQL by concatenating user input; use bind variables or `Database.queryWithBinds`.
- Follow naming conventions:
  - Classes: `PascalCase` with clear business intent (`AccountService`, `OpportunitySelector`).
  - Methods/variables: `camelCase`; constants: `UPPER_SNAKE_CASE`.
  - Test data creation: one shared `TestDataFactory` per project, annotated `@isTest`.
- Keep methods cohesive, small, and testable; avoid deeply nested control flow.
- Prefer reusable utilities/services/selectors over duplicating logic across classes.
- Reuse existing helpers before introducing new abstractions.
- Use collections/maps/sets to optimize lookups and avoid repeated queries.
- Avoid hard-coded IDs and environment-specific assumptions.
- Prefer selector/service/domain-style separation when adding new logic.
- Keep SOQL selective and query only fields actually required.
- Keep DML operations batched and outside loops.
- Keep exceptions explicit and meaningful; do not silently swallow errors.
- Choose DML failure semantics deliberately: plain `insert/update` when the operation must roll back as one; `Database.insert(records, false)` when per-record failure is acceptable - and then HANDLE the `SaveResult`s (report failures), never discard them.
- When several DML steps form one logical operation, protect the invariant with `Database.setSavepoint()`/`Database.rollback()` so a mid-sequence failure cannot leave half-applied state.
- Design for testability: pass collaborating services/selectors in (constructor or parameter) rather than constructing them inline everywhere; use `@TestVisible` sparingly for seams, never to bypass business rules in tests.
- Document only non-obvious business rules or constraints with concise comments.

For performance and reliability:

- Minimize query count and rows returned.
- Design for governor limits and bulk execution even outside trigger contexts.
- Use async Apex only where needed and with clear transactional boundaries.
- Ensure public/global contracts remain backward compatible unless requested.
