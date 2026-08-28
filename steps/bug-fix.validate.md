---
id: bug-fix.validate
title: Validate (check-only deploy of changed files)
type: cli
bin: sf
args:
  - project
  - deploy
  - start
  - --dry-run
  - {changedSourceDirs}
  - --json
  - --wait
  - "30"
---

