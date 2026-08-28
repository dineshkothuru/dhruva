---
id: feature-dev.implement
title: Implement feature + tests (agent)
type: agent
role: implement
---
Implement this feature in the current project.
Requirement: {inputs.requirement}
Approved technical spec:
{steps.spec.output}

Org-refresh delta since the spec was written:
{steps.retrieve-delta.output}
If files are listed in that delta, re-read them and adapt the spec before coding.
Write or update Apex tests for everything you implement (aim for the changed classes to be covered). Follow the existing code style. Never create a parallel implementation of something that already exists. Do not deploy.
