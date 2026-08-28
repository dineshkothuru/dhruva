---
id: test-gen.implement
title: Write the tests (agent)
type: agent
role: implement
---
Write the tests per the approved plan:
{steps.assess.output}

Rules of engagement: modify/create TEST classes (and the shared TestDataFactory if needed) ONLY - never change the production classes under test in this workflow; if a class is untestable as written, report it instead of changing it. Follow the apex-tests standards: TestDataFactory data, Assert class with messages, positive/negative/bulk, System.runAs with permission sets, no SeeAllData. Meaningful assertions over coverage percentage.
