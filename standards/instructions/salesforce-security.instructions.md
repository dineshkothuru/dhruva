---
applyTo: "force-app/main/default/**/*"
---

Salesforce security and data access standards:

Enforcement mechanism (use these, do not invent alternatives):

- Prefer `WITH USER_MODE` on SOQL for user-context reads instead of manual `Schema` describe checks.
- Prefer `Database.insert/update/upsert/delete(records, AccessLevel.USER_MODE)` for user-context DML.
- Use `Security.stripInaccessible(AccessType.CREATABLE|UPDATABLE|READABLE, records)` when partial field filtering is required rather than failing the transaction.
- Use `WITH SYSTEM_MODE` or `AccessLevel.SYSTEM_MODE` only for deliberate system operations, and state the reason in a short comment.
- Do not mix manual `isAccessible()`/`isCreateable()` checks with user-mode operations for the same access path; pick one mechanism per class.

Sharing model:

- Declare sharing explicitly on every class: `with sharing`, `without sharing`, or `inherited sharing`.
- Use `inherited sharing` for service/utility classes that must respect the caller context.
- Use `without sharing` only with an explicit justification comment naming the business reason.
- Remember that sharing keywords do not enforce CRUD/FLS; apply both.

Dynamic SOQL and injection safety:

- Prefer static SOQL with bind variables over dynamic query strings.
- When dynamic SOQL is unavoidable, bind user input with `Database.queryWithBinds` and a bind map rather than string concatenation.
- If concatenation is truly unavoidable, apply `String.escapeSingleQuotes` to every user-supplied fragment and validate identifiers against an allowlist.
- Never build field or object names directly from user input; resolve them through `Schema.getGlobalDescribe` or a fixed allowlist.

Secrets and sensitive data:

- Store credentials in Named Credentials, External Credentials, or protected custom metadata/settings, never in code, tests, or metadata XML.
- Do not log secrets, tokens, session IDs, or unnecessary PII.
- Keep sensitive fields out of error messages, debug logs, platform events, and integration payloads unless required.

Apex exposure surface:

- Keep `@AuraEnabled`, `@RestResource`, `@InvocableMethod`, and `global` methods minimal and validated.
- Re-validate every client-supplied value server side, even when the UI already validates it.
- Return sanitized error messages to clients and keep internal detail in logs.
- Remember `@AuraEnabled(cacheable=true)` methods cannot perform DML.
