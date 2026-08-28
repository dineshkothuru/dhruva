---
id: validate-deploy.validate
title: Check-only deploy
type: cli
bin: sf
args:
  - project
  - deploy
  - start
  - --dry-run
  - --source-dir
  - {inputs.target}
  - --test-level
  - {inputs.testLevel}
  - --json
  - --wait
  - "60"
---

