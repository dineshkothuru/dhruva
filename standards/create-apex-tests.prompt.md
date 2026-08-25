---
mode: agent
description: Create or update Apex tests with bulk, positive, and negative assertions.
# No tools list: inherits your full default tool set so editing and terminal
# access always resolve. VS Code silently ignores unrecognized tool names.
---

You are working in a Salesforce DX repository.

Always apply the MANDATORY TEAM STANDARDS included in this prompt.

Task:

- Create or update test classes for the changed Apex/trigger logic.

Hard requirements:

- Use `@isTest` and `SeeAllData=false` unless explicitly required.
- Use `@TestSetup` for shared data and build records through the shared `TestDataFactory`.
- Extend `TestDataFactory` with a new method when data is missing; do not create a parallel factory class or build records inline.
- Cover single-record and bulk-record behavior.
- Include negative and permission-sensitive scenarios, using `System.runAs` with a permission-set-based user.
- Use `Test.startTest()` and `Test.stopTest()` around governor-sensitive logic.
- Use the `Assert` class with a message on every assertion.
- Assert business outcomes, field values, and record counts, and assert the specific exception type on negative paths.
- Keep tests deterministic and independent of run order.

Before finishing:

- Run the most targeted Apex tests first.
- If a test fails, fix root causes and rerun until green; never weaken an assertion to force a pass.
