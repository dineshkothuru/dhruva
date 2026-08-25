---
applyTo: "force-app/main/default/**/*"
---

Salesforce design standards:

Domain and responsibility boundaries:

- Keep a single source of truth for each business rule to avoid divergence across trigger, flow, and UI paths.
- Keep triggers orchestration-only; place business logic in domain/service layers.
- Use flows for declarative orchestration where stable and low-complexity; move complex logic to Apex services.
- Avoid overlapping automation on the same object event unless execution order and ownership are explicit.

Layering and composition:

- Follow a consistent layering model: trigger/controller -> handler -> service/domain -> selector/repository.
- Keep selectors focused on data access; keep services focused on business behavior.
- Reuse existing services/selectors/components before introducing new artifacts.
- Keep interfaces/contracts stable and intention-revealing.

Integration and API design:

- Design inbound and outbound operations to be idempotent where practical.
- Define explicit retry strategy and failure behavior for async and event-driven integrations.
- Use explicit request/response contracts and version them for breaking changes.
- Keep timeout, error, and partial-failure behavior defined at design time.

Data model evolution:

- Prefer additive schema evolution (new fields/objects) over breaking renames/removals.
- Plan deprecation in stages: introduce replacement, migrate usage, then retire old contract.
- Validate data migration impact on automation, reports, permissions, and integrations.
- Keep API names stable and meaningful; avoid churn in externally consumed fields.

Performance and transaction design:

- Design for bulk inputs by default, including service-entry methods.
- Keep transactions bounded and cohesive; avoid long-running chains with unclear rollback semantics.
- Use async boundaries intentionally for heavy processing, callouts, and large fan-out operations.
- Optimize for query selectivity and minimal field retrieval from the start.

Security and exposure design:

- Apply least-privilege access design across object, field, and record scopes.
- Enforce sharing and CRUD/FLS at service boundaries for user-context operations.
- Avoid exposing sensitive fields in UI, logs, events, and integration payloads unless required.
- Keep permission-set updates part of feature design, not a post-step.

Observability and operability:

- Define diagnostic logging points for key business transitions and failure boundaries; see `salesforce-logging.instructions.md` for the required mechanism.
- Keep logs actionable and correlation-friendly; avoid logging secrets or unnecessary PII.
- Ensure operational alerts can distinguish transient failures from persistent defects.
- Design runbooks/checklists for high-risk or high-volume jobs.
