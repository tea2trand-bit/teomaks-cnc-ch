import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildStaticSite } from "../scripts/build.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("static build publishes only the intended public surface", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "teomaks-static-build-"));
  const outputRoot = join(temporaryRoot, "dist");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  await buildStaticSite({ sourceRoot: repositoryRoot, outputRoot });

  for (const path of [
    "index.html",
    "admin/index.html",
    "assets/favicon.svg",
    "styles.css",
    "script.js",
    "robots.txt",
    "sitemap.xml"
  ]) {
    assert.equal(await exists(join(outputRoot, path)), true, `${path} is published`);
  }

  for (const path of [
    "package.json",
    "package-lock.json",
    "netlify.toml",
    "netlify/functions/customer-logos.js",
    "netlify/database/migrations/0001_create_availability.sql",
    "tests/source-contracts.test.js",
    "availability.json",
    "deno.lock"
  ]) {
    assert.equal(await exists(join(outputRoot, path)), false, `${path} is not published`);
  }

  assert.deepEqual(
    (await readdir(outputRoot)).sort(),
    [
      "admin",
      "agb.html",
      "assets",
      "datenschutz.html",
      "i18n.js",
      "impressum.html",
      "index.html",
      "legal.css",
      "robots.txt",
      "script.js",
      "sitemap.xml",
      "styles.css"
    ].sort()
  );
  assert.deepEqual(await readdir(join(outputRoot, "admin")), ["index.html"]);
});
