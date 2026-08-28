---
id: test-gen.validate
title: Validate with local tests (proves the new tests pass)
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
---

