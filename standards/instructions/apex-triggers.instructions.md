---
applyTo: "force-app/main/default/triggers/**/*.trigger"
---

When editing Salesforce Apex triggers:

- Keep trigger bodies thin; delegate logic to a handler class.
- Maintain one trigger per object and route all contexts through the handler.
- Use context-specific handler methods (`beforeInsert`, `afterUpdate`, etc.).
- Always design for bulk operations across all trigger contexts.
- Never place SOQL or DML inside per-record loops.
- Prevent recursion using established handler guard patterns when needed.
- Avoid callouts directly in triggers; offload to async patterns where required.
- Keep trigger logic deterministic and order-independent.
- Follow naming conventions:
  - Trigger name: `<ObjectName>Trigger`, dropping the `__c` suffix for custom objects (`Invoice__c` becomes `InvoiceTrigger`).
  - Handler name: `<ObjectName>TriggerHandler` using the same convention.
- Reuse shared domain/service logic rather than duplicating business rules in handlers.

If trigger behavior changes, add or update Apex tests that cover:

- single-record and bulk-record execution
- relevant context events
- negative and permission-sensitive scenarios where applicable
