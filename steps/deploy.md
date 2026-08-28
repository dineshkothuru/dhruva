---
id: deploy
type: cli
bin: sf
args:
  - project
  - deploy
  - start
  - {changedSourceDirs}
  - --json
  - --wait
  - "30"
onlyIf: deploy
---

