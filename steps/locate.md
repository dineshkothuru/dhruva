---
id: locate
title: Locate root cause (agent, read-only)
type: agent
role: read
readOnly: true
emits: work
---
You are investigating a bug. DO NOT modify any files in this step.
Bug report: {inputs.description}
Investigate the local codebase and report the diagnosis in EXACTLY this structure:
SYMPTOMS: <what is broken - error messages, logs, observed behavior from the report>
REPRODUCTION: <numbered steps that trigger it, ending in the observed failure; 'not reproducible locally' plus why, if so>
EXPECTED vs ACTUAL: <one line each>
EVIDENCE: <what you checked - classes read, automation traced, config examined>
DATA FLOW: <trace from entry point to the failure point; where it diverges from expected>
ROOT CAUSE: <the actual cause, not a symptom or a guess - with the exact file and line/element reference. If you cannot establish it with evidence, say UNCONFIRMED and list the candidates>
IMPACT: <severity critical/high/medium/low + which users/features are affected + since when if determinable, else 'unknown'>
FIX PLAN: <the concrete fix for exactly this root cause, files to change, and the test that will prove it>
UI BUGS (component not rendering, field missing, wrong layout, broken interaction): the sections still apply, read them as follows. DATA FLOW = the render/event path - flexipage/layout -> component -> wire/controller -> data -> conditional rendering, or click -> handler -> apex -> response. EVIDENCE = markup AND configuration: the component HTML/JS, field-level security, page layouts/flexipages and visibility filters, record types, validation rules, permission sets - many UI symptoms are config visibility, not code. You cannot see a browser: reason from the reported description/screenshots, mark REPRODUCTION as 'visual - verify via the Local Dev preview' where applicable, and say so when the root cause needs on-screen confirmation.
End your reply with one line listing every involved file as project-relative paths:
FILES: force-app/main/default/classes/Example.cls, force-app/main/default/classes/ExampleTest.cls
