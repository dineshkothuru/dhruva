---
applyTo: "force-app/main/default/flows/**/*"
---

When creating or editing Flows:

Ownership and boundaries:

- Keep one automation owner per object event; do not split the same business rule across a flow and an Apex trigger.
- Use record-triggered flows for declarative, low-complexity orchestration.
- Move complex branching, heavy data processing, or reusable business rules into Apex invocable actions.
- Document the intended execution order when multiple flows exist on the same object.

Bulk safety and limits:

- Never place a Get, Create, Update, or Delete element inside a loop; assign records to a collection and act on the collection after the loop.
- Prefer before-save record-triggered flows for same-record field updates to avoid extra DML.
- Keep Get Records selective, request only required fields, and set the record limit where a single record is expected.
- Avoid unbounded loops over large collections; move high-volume work to async paths.

Reliability:

- Add fault paths for every callout, invocable action, and DML element that can fail.
- Keep flows idempotent where re-entry is possible.
- Guard against recursion when a flow updates the same object that triggers it.
- Avoid hard-coded record IDs, user names, and queue names; use custom metadata, custom labels, or lookups.

Security:

- Record-triggered, platform-event-triggered, and scheduled-triggered flows execute in system context without sharing. There is no user-context option for these flow types, so treat that elevation as an explicit security boundary rather than something to configure away.
- Screen flows run in user context by default and can be set to system context with sharing; configure user context only for flow types that actually support it.
- Where permissions must be enforced, do that work in invoked Apex using user-mode operations. Be precise about whose permissions those are: user mode enforces the **runtime principal**, which is not always the person who triggered the work. Platform-event and scheduled paths commonly run as Automated Process, a configured subscriber user, or the default workflow user.
- Data operations performed by Flow elements themselves stay elevated. Moving an operation into Apex is what brings it under user-mode enforcement.
- Check that invoked Apex actions enforce CRUD/FLS as described in the security instructions.
- Do not expose sensitive field values in screen elements, error messages, or emails without a stated requirement.

Maintainability and testing:

- Use clear API names and descriptions for the flow and every element.
- Keep the active version count controlled; delete or deactivate obsolete versions.
- Add Apex tests covering flow-invoked Apex, and validate flow behavior for single-record and bulk DML.
