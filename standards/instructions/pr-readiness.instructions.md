---
applyTo: "force-app/main/default/**/*"
---

PR readiness checklist (must be satisfied before considering work complete):

Definition of done:

- The requested behavior is fully implemented, not partially scaffolded.
- Changed paths are minimal and directly related to the requirement.
- Applicable global and design standards are followed for the touched scope.

Code quality gates:

- No high-risk violations remain for bulk safety, security, reliability, or maintainability.
- Comments are concise and human-like, and only explain non-obvious intent.

Test and validation gates:

- Relevant existing tests are added/updated for changed behavior.
- At least targeted validations are run for modified areas (Apex tests, LWC tests when applicable).
- Assertions verify business outcomes, not just code execution.
- Negative and edge scenarios are covered where risk is non-trivial.

Metadata and deployability gates:

- Metadata is complete and deployable as a coherent unit (code + dependent metadata).
- `*-meta.xml` files stay aligned with source usage/targets.
- Permission-related changes are included when feature access requires them.
- Cross-metadata references are validated after any rename or contract update.

Review and release safety gates:

- Integration points and API contracts remain stable or are intentionally versioned.
- Automation overlap risk is checked (trigger/flow/process interactions).
- Performance and governor risk is reviewed for realistic data volumes.
- Final change summary is clear, concrete, and traceable to requirements.
