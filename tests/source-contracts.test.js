import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("admin cannot save a schedule before an authoritative load", async () => {
  const html = await source("admin/index.html");
  assert.match(html, /id="saveBtn"[^>]*disabled/);
  assert.match(html, /availabilityState!=="ready"/);
  assert.match(html, /JSON\.stringify\(\{booked:Array\.from\(booked\)\.sort\(\),baseBooked\}\)/);
  assert.doesNotMatch(html, /availability\.json/);
});

test("admin inline JavaScript parses", async () => {
  const html = await source("admin/index.html");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "admin script block is present");
  assert.doesNotThrow(() => new Function(script));
});

test("admin password is kept in memory rather than persistent browser storage", async () => {
  const html = await source("admin/index.html");
  assert.doesNotMatch(html, /teomaksAdminPassword/);
  assert.match(html, /autocomplete="current-password"/);
});

test("editing project content does not update its publication state", async () => {
  const code = await source("netlify/functions/completed-projects.js");
  const update = code.match(/UPDATE completed_projects[\s\S]*?RETURNING id/)?.[0];
  assert.ok(update, "project update SQL is present");
  assert.doesNotMatch(update, /active\s*=/);
  assert.match(code, /const active = body\.active !== false/);
});

test("project metadata and new image rows share one database transaction", async () => {
  const code = await source("netlify/functions/completed-projects.js");
  const begin = code.indexOf('await client.query("BEGIN")');
  const update = code.indexOf("UPDATE completed_projects", begin);
  const images = code.indexOf("await insertImageInTransaction(", update);
  const commit = code.indexOf('await client.query("COMMIT")', images);
  assert.ok(begin >= 0 && update > begin && images > update && commit > images);
  assert.match(code, /makeBlobCleanupDue\(db\.pool, "completed-projects", storedKeys\)/);
});

test("failed Blob deletions are durably queued instead of silently ignored", async () => {
  const helper = await source("netlify/functions/_shared/blob-cleanup.js");
  const migration = await source("netlify/database/migrations/0005_create_blob_cleanup_queue.sql");
  assert.match(helper, /INSERT INTO blob_cleanup_queue/);
  assert.match(helper, /ON CONFLICT \(store_name, blob_key\) DO UPDATE/);
  assert.match(helper, /retryQueuedBlobDeletes/);
  assert.match(helper, /blobIsReferenced/);
  assert.match(helper, /context\.waitUntil\(task\)/);
  assert.match(helper, /ORDER BY next_attempt_at, id/);
  assert.match(migration, /UNIQUE \(store_name, blob_key\)/);
  assert.match(migration, /generation BIGINT NOT NULL DEFAULT 1/);
  assert.match(migration, /\(store_name, next_attempt_at, id\)/);
  for (const path of [
    "netlify/functions/customer-logos.js",
    "netlify/functions/completed-projects.js"
  ]) {
    const code = await source(path);
    assert.match(code, /queueBlobCleanupIntents/);
    assert.match(code, /scheduleBlobCleanup\(context, db,/);
    assert.doesNotMatch(code, /await retryQueuedBlobDeletes/);
    assert.doesNotMatch(code, /\.delete\([^)]*\)\.catch\(\(\) => \{\}\)/);
  }
  const scheduled = await source("netlify/functions/blob-cleanup-scheduled.js");
  assert.match(scheduled, /schedule: "@hourly"/);
  assert.match(scheduled, /Promise\.allSettled/);
});

test("replace and delete operations serialize on database row locks", async () => {
  const logos = await source("netlify/functions/customer-logos.js");
  const projects = await source("netlify/functions/completed-projects.js");
  assert.match(logos, /SELECT blob_key FROM customer_logos WHERE id = \$1 FOR UPDATE/);
  assert.match(projects, /SELECT id FROM completed_projects WHERE id = \$1 FOR UPDATE/);
  assert.match(projects, /SELECT blob_key FROM completed_project_images WHERE id = \$1 FOR UPDATE/);
  assert.match(projects, /ORDER BY id\s+FOR UPDATE/);
});

test("Blob intent is recorded before upload and destructive deletes commit it atomically", async () => {
  const projects = await source("netlify/functions/completed-projects.js");
  const remember = projects.indexOf("storedKeys.push(key)");
  const intent = projects.indexOf("queueBlobCleanupIntents(", remember);
  const upload = projects.indexOf("await store.set(key", intent);
  assert.ok(remember >= 0 && intent > remember && upload > intent);
  assert.match(projects, /queueBlobCleanupIntents\([\s\S]*?client,[\s\S]*?keys,[\s\S]*?"delete-project"/);
  assert.doesNotMatch(projects, /clearBlobCleanupIntents\(db\.pool/);

  for (const path of [
    "netlify/functions/customer-logos.js",
    "netlify/functions/completed-projects.js"
  ]) {
    const code = await source(path);
    assert.match(code, /clearBlobCleanupIntents\([\s\S]*?client,[\s\S]*?await client\.query\("COMMIT"\)/);
  }
});

test("reorder operations acquire target locks in deterministic id order", async () => {
  for (const path of [
    "netlify/functions/customer-logos.js",
    "netlify/functions/completed-projects.js"
  ]) {
    const code = await source(path);
    assert.match(code, /const lockIds = \[\.\.\.ids\]\.sort\(\(a, b\) => a - b\)/);
    assert.match(code, /WHERE id = ANY\(\$1::int\[\]\) ORDER BY id FOR UPDATE/);
  }
});

test("functions no longer grant wildcard cross-origin browser access", async () => {
  for (const path of [
    "netlify/functions/availability.js",
    "netlify/functions/customer-logos.js",
    "netlify/functions/completed-projects.js"
  ]) {
    const code = await source(path);
    assert.doesNotMatch(code, /Access-Control-Allow-Origin/);
  }
});

test("static security headers and admin noindex are configured", async () => {
  const config = await source("netlify.toml");
  const admin = await source("admin/index.html");
  assert.match(config, /command = "npm test && npm run build"/);
  assert.match(config, /publish = "dist"/);
  assert.match(config, /X-Content-Type-Options = "nosniff"/);
  assert.match(config, /X-Frame-Options = "DENY"/);
  assert.match(config, /X-Robots-Tag = "noindex, nofollow, noarchive"/);
  assert.match(admin, /name="robots" content="noindex,nofollow,noarchive"/);
  assert.match(admin, /#loginCard\{width:100%;max-width:560px;margin-inline:auto\}/);
});

test("completed project cards preserve full images and expose an accessible viewer", async () => {
  const html = await source("index.html");
  const script = await source("script.js");
  const styles = await source("styles.css");
  const i18n = await source("i18n.js");

  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /<dialog class="project-lightbox" id="projectImageDialog" aria-labelledby="projectImageDialogTitle">/);
  assert.match(html, /id="projectImageDialogClose"[^>]*type="button"[^>]*aria-label="Bild schließen"/);
  assert.match(html, /id="projectImageDialogOriginal"[^>]*target="_blank"[^>]*rel="noopener"/);

  const photoRule = styles.match(/\.project-photo\{([\s\S]*?)\}/)?.[1];
  const imageRule = styles.match(/\.project-photo img\{([\s\S]*?)\}/)?.[1];
  assert.ok(photoRule, "project photo CSS rule is present");
  assert.ok(imageRule, "project image CSS rule is present");
  assert.match(photoRule, /aspect-ratio:3\/2/);
  assert.doesNotMatch(photoRule, /height:/);
  assert.match(imageRule, /object-fit:contain/);
  assert.doesNotMatch(imageRule, /object-fit:cover/);
  assert.doesNotMatch(styles, /\.project-photo\{height:190px\}/);
  assert.match(styles, /\.project-lightbox:not\(\[open\]\)\{display:none\}/);

  assert.match(script, /action\.setAttribute\("aria-haspopup", "dialog"\)/);
  assert.match(script, /action\.setAttribute\("aria-controls", "projectImageDialog"\)/);
  assert.match(script, /projectImageDialog\.showModal\(\)/);
  assert.match(script, /projectImageDialogTrigger\.focus\(\)/);
  assert.match(script, /if\(event\.target === projectImageDialog\) projectImageDialog\.close\(\)/);
  assert.match(script, /if\(event\.key === "Escape"\)/);
  assert.match(i18n, /window\.updateProjectUiLanguage/);
});

test("multiline checked project summaries render as safe semantic lists", async () => {
  const script = await source("script.js");
  const renderer = script.match(/function appendProjectSummary[\s\S]*?\n\}\n\nasync function loadCompletedProjects/)?.[0];
  assert.ok(renderer, "project summary renderer is present");
  assert.match(renderer, /text\.split\(\/\\r\?\\n\/\)/);
  assert.match(renderer, /lines\.every\(line => \/\^\[✔✓\]/);
  assert.match(renderer, /document\.createElement\("ul"\)/);
  assert.match(renderer, /list\.className = "project-checklist"/);
  assert.match(renderer, /document\.createElement\("li"\)/);
  assert.match(renderer, /item\.textContent = line\.replace/);
  assert.match(renderer, /summary\.className = "project-summary"/);
  assert.doesNotMatch(renderer, /innerHTML/);
});

test("shared Blob mutations and cleanup fail closed outside published production", async () => {
  const logos = await source("netlify/functions/customer-logos.js");
  const projects = await source("netlify/functions/completed-projects.js");
  const scheduled = await source("netlify/functions/blob-cleanup-scheduled.js");

  const verify = logos.indexOf('action === "verify"');
  const logoGuard = logos.indexOf("!isPublishedProductionDeploy(context)", verify);
  const logoCreate = logos.indexOf('action === "create"', logoGuard);
  assert.ok(verify >= 0 && logoGuard > verify && logoCreate > logoGuard);

  const projectGuard = projects.indexOf("!isPublishedProductionDeploy(context)");
  const projectCreate = projects.indexOf('action === "create"', projectGuard);
  assert.ok(projectGuard >= 0 && projectCreate > projectGuard);

  const scheduledGuard = scheduled.indexOf("!isPublishedProductionDeploy(context)");
  const scheduledDatabase = scheduled.indexOf("getDatabase()", scheduledGuard);
  assert.ok(scheduledGuard >= 0 && scheduledDatabase > scheduledGuard);
});
