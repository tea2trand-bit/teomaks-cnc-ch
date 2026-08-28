import assert from "node:assert/strict";
import test from "node:test";

import { jsonResponse, responseHeaders, textResponse } from "../netlify/functions/_shared/http.js";

test("JSON responses are non-cacheable and protected from MIME sniffing", async () => {
  const response = jsonResponse({ ok: true });
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(await response.json(), { ok: true });
});

test("binary response headers can keep their explicit cache policy", () => {
  const headers = new Headers(responseHeaders({
    "Content-Type": "image/webp",
    "Cache-Control": "public, max-age=0, must-revalidate"
  }));
  assert.equal(headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
});

test("plain errors use text content type and no-store", () => {
  const response = textResponse("Not found", 404);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
});
