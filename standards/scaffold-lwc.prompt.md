---
mode: agent
description: Scaffold or update LWC with SLDS, accessibility, and Apex integration patterns.
# No tools list: inherits your full default tool set so editing and terminal
# access always resolve. VS Code silently ignores unrecognized tool names.
---

You are implementing a Lightning Web Component in a Salesforce DX repo.

Always apply the MANDATORY TEAM STANDARDS included in this prompt.

Task:

- Build or update an LWC with clean separation of HTML/JS/CSS.

Requirements:

- Follow SLDS and accessibility best practices (labels, keyboard behavior, aria attributes).
- Use `@wire` for cacheable reads and imperative Apex for mutations.
- Show clear loading and error UX (spinners, toasts, inline errors as appropriate).
- Keep `@api` surface minimal and stable.
- Keep `*.js-meta.xml` targets and visibility consistent with component usage.

Validation:

- Run targeted Jest tests for the changed component when present.
- Ensure metadata and imports are valid for deployment.
