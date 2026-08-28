---
id: bug-fix.implement
title: Implement the fix (re-verifies only if the org drifted)
type: agent
role: implement
---
Implement the fix for this bug.
Bug report: {inputs.description}
Approved plan from the investigation step:
{steps.locate.output}

The affected files were re-retrieved from the org after the investigation. This is the exact delta between what the investigation saw and the org's current version:
{steps.retrieve-delta.output}
Use that delta ONLY to decide whether the investigation is still valid. Ignore any path outside force-app - harness bookkeeping under .dhruva is not org drift.

- No force-app file listed: the investigation saw exactly what the org has. Implement the plan directly. Do NOT re-investigate.
- A force-app file listed that the investigation named: re-read THAT file, confirm the bug is still present and the plan still applies, then implement. If the fresh code already contains the fix, say so and change nothing.
- A force-app file listed that the investigation did not name: note it in your output and carry on. It is not evidence the diagnosis is wrong.

You are not re-doing the investigation. The root cause was found, reviewed and approved; your job is to apply it to the current code, and to notice only if the current code has moved out from under it.

Never create a new file, class, or method when an existing one should be edited - search for existing implementations first and modify them. Only change what the plan requires. Do not deploy.
