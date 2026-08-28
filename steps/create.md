---
id: create
title: Create scratch org
type: cli
bin: sf
args:
  - org
  - create
  - scratch
  - --definition-file
  - config/project-scratch-def.json
  - --alias
  - {inputs.alias}
  - --duration-days
  - {inputs.days}
  - --json
  - --wait
  - "20"
---

