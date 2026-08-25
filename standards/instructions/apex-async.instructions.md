---
applyTo: "force-app/main/default/classes/**/*.cls"
---

When writing asynchronous Apex (Queueable, Batch, Schedulable, Future, Platform Events):

Choosing the right pattern:

- Use Queueable for chained, stateful, or callout-bearing async work; prefer it over `@future` for new code.
- Use Batch Apex for large data volumes that exceed synchronous query or DML limits.
- Use Schedulable only as a thin entry point that delegates to a Queueable or Batch class.
- Use Platform Events for decoupled, event-driven integration rather than tight synchronous chaining.
- Avoid `@future` unless required for legacy compatibility; it cannot be chained or monitored well.

Implementation rules:

- Implement `Database.AllowsCallouts` only when the job actually performs callouts.
- Use `Database.Stateful` only for state that is genuinely required across batches, and keep that state small.
- Keep batch scope explicit and tuned to the work performed; do not rely on the default without consideration.
- Make async jobs idempotent so a retry cannot double-apply business effects.
- Guard against unbounded chaining; enforce a stop condition and a maximum depth.
- Do not enqueue jobs inside loops; collect work and enqueue once.

Error handling and observability:

- Implement `finish` in Batch classes to report outcomes and failures.
- Capture per-record failures from `Database.insert(records, false)` style calls and report them; do not discard results.
- Log correlation identifiers so a failed job can be traced end to end.
- Do not silently swallow exceptions in async context; failures there are invisible to users.

Testing async Apex:

- Wrap async execution in `Test.startTest()` and `Test.stopTest()` so jobs complete before assertions.
- Assert business outcomes after `Test.stopTest()`, not just that the job was enqueued.
- Cover bulk volumes that reflect realistic batch boundaries.
- Use `Test.setMock` for callouts and assert both success and failure handling.
