---
id: validate-tests
title: Validate with local tests
type: cli
bin: sf
args:
  - project
  - deploy
  - start
  - --dry-run
  - {changedSourceDirs}
  - --test-level
  - RunLocalTests
  - --json
  - --wait
  - "60"
onlyIf: runTests
---

