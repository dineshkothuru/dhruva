---
id: ux-design.write-doc
title: Write the UX spec document + build-plan tasks
type: agent
role: design
persona: salesforce-writer
timeoutMinutes: 30
---
Write the APPROVED UX design as a developer-ready spec plus a machine-readable tasks file (create folders if needed). These two files are the only ones you may create or modify in this step:

1. .dhruva/runs/{runId}/docs/ux.md - the UX SPEC, numbered sections: 1. Context and design conventions applied; 2. Component inventory (per UX-n: exact LWC API name, composition, states, interactions/data contract, accessibility, reuse decisions); 3. Navigation/flow between components; 4. Test strategy (Jest per component: states, events, accessibility asserts); 5. Open questions. Plain ASCII punctuation, exact API names in backticks, tables where they beat prose.

2. .dhruva/runs/{runId}/docs/tasks.json - strict JSON, exactly this shape:
{ "version": 1, "tasks": [ { "id": "T-1", "title": "<imperative>", "depends_on": [], "files": ["force-app/main/default/lwc/example/example.html"], "change": "<what to build>", "test_scenarios": ["<case>"], "traces": ["UX-1"], "status": "pending" } ] }
One component (markup+JS+meta plus its Jest test) per task; every task traces to at least one UX-n; depends_on only references earlier tasks; order = safe build order.

Approved UX design:
{steps.ux-design.output}

Incorporate every approved detail; do not contradict what was approved.
