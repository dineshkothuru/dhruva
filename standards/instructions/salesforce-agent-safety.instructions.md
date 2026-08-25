---
applyTo: "**/*"
---

Salesforce CLI and org safety rules for automated agents:

Never run against a connected org without an explicit request:

- Do not run `sf project deploy start`, `sf project deploy quick`, or any push that writes metadata to an org.
- Do not run `sf project delete source`, `sf project delete tracking`, or any destructive metadata command.
- Do not run `sf data delete`, `sf data update`, `sf data import`, or `sf apex run` against a non-scratch org.
- Do not create, delete, or reset scratch orgs unless asked.
- Do not modify org authentication, aliases, or the default org.

Preferred safe commands:

- Validate instead of deploy: `sf project deploy validate` when a reusable validation Id for a later quick deploy is wanted, or `sf project deploy start --dry-run` for a throwaway check. `sf project deploy validate` has no `--dry-run` flag; do not invent one.
- Inspect instead of mutate: `sf project retrieve preview`, `sf org list`, `sf data query`.
- Run tests with an explicit, targeted selection: `sf apex run test --tests <ClassName> --result-format human --wait 10`.
- Prefer local validation (`npm run lint`, `npm run test:unit`, `npm run scan`) before anything that touches an org.

Before any org-affecting command:

- State which org alias will be affected and confirm it is the intended target.
- Confirm the command is non-destructive, or ask for explicit approval when it is not.
- Never assume the default org is a sandbox or scratch org; it may be production.

Secrets:

- Do not print, log, or commit auth tokens, `sfdx-auth-url` values, connected app secrets, or `.sf`/`.sfdx` contents.
- Do not commit retrieved org data or debug logs that contain production records.
