import assert from "node:assert/strict";
import test from "node:test";

import { isPublishedProductionDeploy } from "../netlify/functions/_shared/deploy-context.js";

test("media mutations are allowed only on the published production deploy", () => {
  assert.equal(isPublishedProductionDeploy({
    deploy: { context: "production", published: true }
  }), true);

  for (const context of [
    undefined,
    {},
    { deploy: {} },
    { deploy: { context: "production", published: false } },
    { deploy: { context: "deploy-preview", published: false } },
    { deploy: { context: "branch-deploy", published: false } },
    { deploy: { context: "dev", published: false } }
  ]) {
    assert.equal(isPublishedProductionDeploy(context), false);
  }
});
