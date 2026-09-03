---
applyTo: "force-app/main/default/classes/**/*Test.cls"
roles: "implement, review, trace"
---

When editing Apex test classes:

- Use `@isTest` classes/methods and keep tests isolated (`SeeAllData=false` unless required).
- Build test data through the shared `TestDataFactory` class rather than inline record construction.
- Add a method to `TestDataFactory` instead of creating per-object variants such as `AccountTestFactory` or `ContactBuilder`.
- Follow naming conventions:
  - Test classes: `<ClassName>Test`.
  - Test methods: `camelCase` describing scenario and expected outcome, for example `updatesRatingWhenRevenueExceedsThreshold`.
- Use `@TestSetup` for shared setup data, and keep per-test data creation for scenario-specific records.
- Cover positive, negative, bulk, and edge scenarios tied to business logic.
- Use `Test.startTest()` / `Test.stopTest()` around async/governor-sensitive execution.
- Use the `Assert` class (`Assert.areEqual`, `Assert.isTrue`, `Assert.fail`) rather than the legacy `System.assert*` methods.
- Assert outcomes, not just execution; include field-level and record-count expectations.
- Include an assertion message on every assert so failures are diagnosable without reading the test body.
- Assert error conditions explicitly for negative paths; catch the expected exception type and assert its message rather than using a bare `try/catch`.
- Test permission-sensitive behavior with `System.runAs` using a user built from a permission set, not a hard-coded profile name.
- Keep tests deterministic and independent of execution order; never rely on `SeeAllData` or existing org data.
- Keep factory methods bulk-first: accept a count, return a `List`, and leave insertion to the caller.
- Use unique values for fields under unique or duplicate rules so bulk inserts do not collide.
- Create test users through `TestDataFactory` and grant access with a permission set; never select a privileged profile to make a test pass.
- Watch for `MIXED_DML_OPERATION` when a test inserts both setup objects (User, Group) and regular records. Separate them with `System.runAs(new User(Id = UserInfo.getUserId()))`; moving the DML into another method does not create a transaction boundary.
- Keep each test focused on one behavior and one primary assertion goal.

Aim for meaningful coverage that protects behavior, not only percentage targets. Coverage percentage is a deployment gate, not a quality goal.
