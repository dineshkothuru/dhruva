---
applyTo: "force-app/main/default/triggers/**/*.trigger"
---

When editing Salesforce Apex triggers:

- Keep triggers thin: delegate immediately to the established trigger handler pattern; never place business logic, SOQL, DML, callouts, or complex branching in the trigger body.
- Maintain one trigger per object; route by the `Trigger` context flags to context-specific handler methods (`beforeInsert`, `afterUpdate`, etc.).
- Pass `Trigger.new`, `Trigger.old`, `Trigger.newMap`, and `Trigger.oldMap` into the handler as collections/maps; never process records one at a time.
- Handler logic must support batches of at least 200 records: query related data once, index it in maps, and perform DML on collections outside loops.
- Prevent recursive updates deliberately: use context-aware handler design or a narrowly scoped recursion guard. Do NOT use a static Boolean that suppresses later batches — the trigger re-fires per 200-record chunk in the same transaction, and a transaction-wide Boolean silently skips every chunk after the first.
- Prefer `before` triggers for setting values on the triggering records (no DML needed); use `after` triggers only when record IDs or persisted state is required.
- Keep trigger behavior deterministic and order-independent across insert, update, delete, and undelete contexts. Compare old and new values before performing update-specific work.
- Avoid callouts anywhere in the trigger path; offload to async patterns (queueable/platform events) where required — and aggregate first: enqueue ONE async job per transaction for the affected records, never one per record.
- Recursion sources include the platform itself: workflow field updates, processes, and record-triggered flows re-fire the trigger within the same save. Design guards against re-entry from those, not only from your own DML.
- Surface record-level failures with `addError()` on the offending records (keeps partial success working for bulk loads); throw exceptions only for invariant violations where the whole transaction must roll back.
- Follow naming conventions:
  - Trigger name: `<ObjectName>Trigger`, dropping the `__c` suffix for custom objects (`Invoice__c` becomes `InvoiceTrigger`).
  - Handler name: `<ObjectName>TriggerHandler` using the same convention.
- Reuse shared domain/service logic rather than duplicating business rules in handlers.

If trigger behavior changes, add or update Apex tests that cover:

- single-record and bulk-record execution (200+ records)
- the affected trigger contexts and expected failures
- negative and permission-sensitive scenarios where applicable
