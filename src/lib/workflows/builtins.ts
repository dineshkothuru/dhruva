/** Built-in workflow library — one definition per file under definitions/.
 * Ships with the harness so every team member runs the same standard paths. */

import type { WorkflowDef } from "./schema";
import { checkWorkflowSemantics } from "./validate";
import { BUG_FIX } from "./definitions/bug-fix";
import { FEATURE_DEV } from "./definitions/feature-dev";
import { SOLUTION_DESIGN } from "./definitions/solution-design";
import { IMPLEMENT_TDD } from "./definitions/implement-tdd";
import { TEST_GEN } from "./definitions/test-gen";
import { RETRIEVE_SYNC } from "./definitions/retrieve-sync";
import { DEPLOY_PREVIEW } from "./definitions/deploy-preview";
import { VALIDATE_DEPLOY } from "./definitions/validate-deploy";
import { RUN_TESTS } from "./definitions/run-tests";
import { SCRATCH_ORG } from "./definitions/scratch-org";

export const WORKFLOWS: Record<string, WorkflowDef> = {
  [BUG_FIX.id]: BUG_FIX,
  [FEATURE_DEV.id]: FEATURE_DEV,
  [SOLUTION_DESIGN.id]: SOLUTION_DESIGN,
  [IMPLEMENT_TDD.id]: IMPLEMENT_TDD,
  [TEST_GEN.id]: TEST_GEN,
  [RETRIEVE_SYNC.id]: RETRIEVE_SYNC,
  [DEPLOY_PREVIEW.id]: DEPLOY_PREVIEW,
  [VALIDATE_DEPLOY.id]: VALIDATE_DEPLOY,
  [RUN_TESTS.id]: RUN_TESTS,
  [SCRATCH_ORG.id]: SCRATCH_ORG,
};

// Built-ins are held to the same deterministic semantic checks as customs.
// Loud in dev so a broken definition can never ship silently.
if (process.env.NODE_ENV !== "production") {
  for (const def of Object.values(WORKFLOWS)) {
    const problems = checkWorkflowSemantics(def);
    if (problems.length > 0) {
      throw new Error(`built-in workflow "${def.id}" is invalid: ${problems.join("; ")}`);
    }
  }
}
