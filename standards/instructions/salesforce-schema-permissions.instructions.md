---
applyTo: "force-app/main/default/{objects,permissionsets,profiles,labels}/**/*"
---

When changing schema, permissions, or labels:

Object and field design:

- Prefer additive change: add new fields and objects instead of renaming or deleting existing ones.
- Use clear API names that describe business meaning, and keep them stable once integrations consume them.
- Choose the narrowest correct data type; avoid oversized text fields and unnecessary formula complexity.
- Set field-level `description` and help text so the model stays self-documenting.
- Mark fields required at the database level only when the rule is truly universal; otherwise enforce it in validation rules or UI.
- Consider indexing and selectivity for fields used in filters, especially on high-volume objects.
- Prefer picklists backed by global value sets when the same values are reused across objects.

Deletion and rename safety:

- Never rename or delete a field, object, or relationship without confirming impact on Apex, flows, reports, list views, integrations, and permission sets.
- Follow staged deprecation: introduce the replacement, migrate usage, then retire the old field.

Permission design:

- Grant access through permission sets and permission set groups, not profiles.
- Keep permission sets feature-scoped and least-privilege; avoid broad catch-all permission sets.
- Ship permission updates in the same change set as the feature that requires them.
- Do not grant `Modify All Data`, `View All Data`, or broad object-level access to solve a narrow access problem.
- Keep field-level security explicit for sensitive fields, and confirm exposure before granting read access.

Validation rules:

- Keep validation rule logic readable and specific, with an actionable error message on the correct field.
- Avoid rules that block legitimate bulk data loads and integration writes without an escape path.

Labels and text:

- Put user-facing strings in custom labels rather than hard-coding them in Apex or LWC.
- Keep label API names descriptive and grouped by feature category.
