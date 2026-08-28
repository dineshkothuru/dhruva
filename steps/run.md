---
id: run
title: Run tests
type: cli
bin: sf
args:
  - apex
  - run
  - test
  - --test-level
  - {inputs.level}
  - {opt:--tests:inputs.tests}
  - {flag:--synchronous:inputs.synchronous}
  - --code-coverage
  - --result-format
  - json
  - --json
  - --wait
  - "60"
---

