---
id: push
title: Push local source into the scratch org
type: cli
bin: sf
args:
  - project
  - deploy
  - start
  - --source-dir
  - force-app
  - --target-org
  - {inputs.alias}
  - --json
  - --wait
  - "60"
---

