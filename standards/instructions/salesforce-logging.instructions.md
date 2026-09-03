---
applyTo: "force-app/main/default/classes/**/*.cls"
roles: "implement, review"
---

Logging and observability standards for Apex:

`System.debug` is not application logging:

- `System.debug` is a development aid only. It requires an active trace flag, is discarded when debug logs age out, and is invisible in production.
- Do not use `System.debug` to record business events, integration outcomes, or handled failures.
- Do not leave `System.debug` statements in delivered code. The single exception is the `Logger` facade's own failure path, where no other channel is available.

Use the project `Logger` facade:

- Route all application logging through a single `Logger` class so the implementation can change without touching business code.
- Call the facade from service, domain, and integration layers; do not log from selectors or from inside tight loops.
- Never construct log records directly in business logic.

Durability:

- If logs are persisted through Platform Events, the event must be configured with `PublishImmediately`. The default `PublishAfterCommit` is discarded when the transaction rolls back, which is exactly when the log is needed.
- Platform Events are retained for a limited window and are not themselves a durable log. A subscriber must write to a durable sink with a defined retention and purge policy.
- Buffer log entries in memory and flush once per transaction; never publish an event per record in a loop.
- Flush on exception paths too, using `finally`, or the entries describing a failure are lost with it.
- Inspect the `Database.SaveResult` values returned by `EventBus.publish` and by log DML. The rule against silently discarding per-record failures applies to the logger itself.
- Treat log publishing as best effort. A logging failure must never break the business transaction.
- Do not invent `Logger` method signatures. If no logging facade exists in the repository yet, say so and propose adopting one rather than emitting calls to a class that does not exist.
- This repository specifies the logging contract, not an implementation. Either adopt a maintained logger such as Nebula Logger or implement the full contract in `docs/reference-patterns.md`; do not ship a publisher alone and call it logging.

What to log:

- Log at business transitions, integration boundaries, and handled failure paths.
- Always log unhandled and rethrown exceptions with the stack trace at the point where they are caught.
- Log async job outcomes, because failures in Queueable, Batch, and Schedulable contexts are otherwise invisible to users.
- Do not log successful reads, per-record iteration, or anything that produces one entry per record in a bulk operation.

Levels:

- `ERROR` for failures needing intervention, `WARN` for recoverable or degraded behavior, `INFO` for significant business transitions, `DEBUG` for diagnostic detail that is off by default in production.
- Make the active level configurable through custom metadata or a custom setting, not a hard-coded constant.

Correlation:

- Attach `Request.getCurrent().getRequestId()` to every entry so all logs from one transaction can be grouped.
- Carry a business identifier such as the record Id, job Id, or external transaction Id where one exists.
- Include the originating class and method so an entry can be traced to source.

Sensitive data:

- Never log secrets, tokens, session Ids, passwords, or full integration payloads containing credentials.
- Do not log PII unless the business requires it and retention is defined; prefer record Ids over field values.
- Sanitize error text from external systems before storing it.

Retention and volume:

- Define a retention and purge strategy for stored logs; unbounded log objects become a storage and performance problem.
- Keep logging off the critical path for high-volume jobs, and consider sampling for very high-frequency events.
- Remember that Platform Event publishing consumes governor and daily event limits; log deliberately.

Testing:

- Assert that failure paths log, using the `Logger` facade's test hooks rather than parsing debug output.
- Do not assert on `System.debug` output.
