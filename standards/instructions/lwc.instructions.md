---
applyTo: "force-app/main/default/lwc/**/*.{js,html,css,xml}"
roles: "implement, review"
---

When editing Lightning Web Components:

- Keep components focused: UI in templates, logic in JS, styling in CSS.
- Prefer reusable components and shared utilities wherever possible; avoid copy/paste logic.
- Follow naming conventions:
  - Folders/components: `camelCase` (for example `accountSummaryCard`).
  - JavaScript classes: `PascalCase` matching the component name.
  - Public properties/methods: clear `camelCase` names with stable contracts.
- Prefer reactive tracked/state patterns and avoid unnecessary rerenders.
- Use `@wire` for cacheable/read scenarios and imperative calls for mutations.
- For GraphQL-based reads, keep query definitions reusable, request only required fields, and handle loading/error states explicitly.
- Surface user feedback with standard Salesforce UX patterns (toasts/spinners/errors).
- Follow SLDS and accessibility requirements (labels, keyboard support, aria attributes).
- No custom CSS: compose from lightning base components and SLDS utility classes only. Adding a component `.css` file requires a documented justification in the PR/design; prefer restructuring the markup instead.
- Navigate with `NavigationMixin` and page references only - never `window.location` or hardcoded URLs (they break in Experience Cloud and app contexts).
- Every `@wire` gets an error branch (`{ error, data }`) and every imperative Apex call a `catch`; surface failures to the user via `ShowToastEvent` with a safe message - no silent empty states.
- Do not use `@track` (legacy) - fields are reactive by default; reassign objects/arrays to trigger rerenders.
- Put user-facing text in Custom Labels, not hardcoded strings, so the org stays translatable.
- Validate input on client side and re-validate on server side in Apex.
- Keep API contracts (`@api`) minimal and stable.
- Keep events explicit and documented via clear event names/payload shapes.

For data and security:

- Use Lightning Data Service where appropriate.
- Prefer GraphQL for multi-object read composition when it simplifies data access and stays within existing architecture patterns.
- Avoid exposing sensitive details in client-side code or error messages.
- Prefer centralized constants/helpers for repeated labels, messages, and mapping logic.
- Ensure metadata config (`*.js-meta.xml`) stays aligned with component usage targets.
