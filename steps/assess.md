---
id: assess
title: Assess coverage gaps (agent, read-only)
type: agent
role: read
persona: salesforce-test
readOnly: true
---
Target: {inputs.target}
Read the target classes IN FULL and their existing test classes (if any). DO NOT modify any files in this step. Identify the untested or weakly tested behavior: public methods, branches, error paths, bulk behavior, permission-sensitive logic. Propose a test plan: which test classes to create or extend, and the scenarios per class (positive / negative / bulk / permission). Note whether a shared TestDataFactory exists and what it is missing.
End with one line listing every EXISTING file you will modify as project-relative paths:
FILES: force-app/main/default/classes/ExampleTest.cls
