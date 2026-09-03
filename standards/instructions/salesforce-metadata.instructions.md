---
applyTo: "force-app/main/default/**/*-meta.xml"
roles: "implement, review"
---

When editing Salesforce metadata XML:

- Preserve valid metadata schema and expected tag ordering used in this repo.
- Keep API versions consistent with surrounding metadata unless intentionally changing.
- Do not raise a component's API version opportunistically. Salesforce uses API version to gate backward-incompatible behavior, so a bump is a behavior change that needs a test run.
- Never set an API version above what the target org supports; the deploy will fail. Check with `npm run check:api-version`.
- Do not remove targets, capabilities, or visibility settings without verifying impact.
- Ensure profile/permission-dependent metadata updates are reflected where required.
- Keep component and metadata names aligned with file/folder naming conventions.
- Follow naming conventions consistent with Salesforce metadata type expectations.
- Ensure labels/descriptions are meaningful and consistent with existing naming in the org.
- Avoid introducing environment-specific values.
- Keep XML minimal: include only required, intentional changes to reduce deployment risk.
