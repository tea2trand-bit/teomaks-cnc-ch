import assert from "node:assert/strict";
import test from "node:test";

import {
  clearBlobCleanupIntents,
  deleteBlobOrQueue,
  deleteBlobsOrQueue,
  makeBlobCleanupDue,
  queueBlobCleanupIntents,
  retryQueuedBlobDeletes,
  scheduleBlobCleanup
} from "../netlify/functions/_shared/blob-cleanup.js";

function fakeStore(deleteImpl) {
  return () => ({ delete: deleteImpl });
}

test("ambiguous commit cleanup retains a Blob that the database references", async () => {
  const sql = [];
  const db = {
    pool: {
      query: async (query, values) => {
        sql.push({ query, values });
        return { rows: [{ referenced: true }] };
      }
    }
  };
  let deletes = 0;
  const deleted = await deleteBlobOrQueue(
    db,
    "customer-logos",
    "logo-new",
    "ambiguous-commit",
    fakeStore(async () => { deletes += 1; })
  );

  assert.equal(deleted, true);
  assert.equal(deletes, 0);
  assert.equal(sql.length, 1);
  assert.match(sql[0].query, /SELECT EXISTS/);
});

test("an unreferenced Blob deletion failure is durably queued", async t => {
  t.mock.method(console, "error", () => {});
  const sql = [];
  const db = {
    pool: {
      query: async (query, values) => {
        sql.push({ query, values });
        if (/SELECT EXISTS/.test(query)) return { rows: [{ referenced: false }] };
        if (/INSERT INTO blob_cleanup_queue/.test(query)) return { rows: [] };
        throw new Error(`Unexpected SQL: ${query}`);
      }
    }
  };

  const deleted = await deleteBlobOrQueue(
    db,
    "completed-projects",
    "project-old",
    "replace-old",
    fakeStore(async () => { throw new Error("Blob outage"); })
  );

  assert.equal(deleted, false);
  assert.equal(sql.length, 2);
  assert.match(sql[1].query, /ON CONFLICT \(store_name, blob_key\) DO UPDATE/);
  assert.deepEqual(sql[1].values.slice(0, 3), ["completed-projects", "project-old", "replace-old"]);
});

test("a failed reference check never deletes the Blob", async t => {
  t.mock.method(console, "error", () => {});
  let deletes = 0;
  let queued = 0;
  const db = {
    pool: {
      query: async query => {
        if (/SELECT EXISTS/.test(query)) throw new Error("database unavailable");
        if (/INSERT INTO blob_cleanup_queue/.test(query)) {
          queued += 1;
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${query}`);
      }
    }
  };

  const deleted = await deleteBlobOrQueue(
    db,
    "customer-logos",
    "logo-uncertain",
    "reference-check",
    fakeStore(async () => { deletes += 1; })
  );

  assert.equal(deleted, false);
  assert.equal(deletes, 0);
  assert.equal(queued, 1);
});

test("retry drops a queued key that became referenced without deleting it", async () => {
  const sql = [];
  const db = {
    pool: {
      query: async (query, values) => {
        sql.push({ query, values });
        if (/FROM blob_cleanup_queue/.test(query)) {
          return { rows: [{ id: 7, blob_key: "logo-live", generation: 4 }] };
        }
        if (/SELECT EXISTS/.test(query)) return { rows: [{ referenced: true }] };
        if (/DELETE FROM blob_cleanup_queue/.test(query)) return { rows: [] };
        throw new Error(`Unexpected SQL: ${query}`);
      }
    }
  };
  let deletes = 0;

  const result = await retryQueuedBlobDeletes(
    db,
    "customer-logos",
    1,
    fakeStore(async () => { deletes += 1; })
  );

  assert.deepEqual(result, { deleted: 0, retained: 1, pending: 0 });
  assert.equal(deletes, 0);
  assert.match(sql[0].query, /next_attempt_at <= NOW\(\)/);
  assert.match(sql[0].query, /ORDER BY next_attempt_at, id/);
  assert.deepEqual(sql[0].values, ["customer-logos", 1]);
  assert.match(sql.at(-1).query, /DELETE FROM blob_cleanup_queue/);
  assert.match(sql.at(-1).query, /generation = \$2/);
  assert.deepEqual(sql.at(-1).values, [7, 4]);
});

test("failed retries rotate with a future next-attempt timestamp", async t => {
  t.mock.method(console, "error", () => {});
  const sql = [];
  const db = {
    pool: {
      query: async (query, values) => {
        sql.push({ query, values });
        if (/FROM blob_cleanup_queue/.test(query)) {
          return { rows: [{ id: 9, blob_key: "project-stuck", generation: 6 }] };
        }
        if (/SELECT EXISTS/.test(query)) return { rows: [{ referenced: false }] };
        if (/UPDATE blob_cleanup_queue/.test(query)) return { rows: [] };
        throw new Error(`Unexpected SQL: ${query}`);
      }
    }
  };

  const result = await retryQueuedBlobDeletes(
    db,
    "completed-projects",
    1,
    fakeStore(async () => { throw new Error("still unavailable"); })
  );

  assert.deepEqual(result, { deleted: 0, retained: 0, pending: 1 });
  const update = sql.find(entry => /UPDATE blob_cleanup_queue/.test(entry.query));
  assert.ok(update);
  assert.match(update.query, /next_attempt_at = NOW\(\)/);
  assert.match(update.query, /LEAST\(attempts \+ 1, 60\)/);
  assert.match(update.query, /generation = \$3/);
  assert.deepEqual(update.values.slice(1), [9, 6]);
});

test("worker cannot delete a newer cleanup intent after a stale reference check", async () => {
  let queued = { id: 11, blob_key: "logo-raced", generation: 1 };
  let releaseReferenceCheck;
  let referenceCheckStarted;
  const started = new Promise(resolve => { referenceCheckStarted = resolve; });
  const gate = new Promise(resolve => { releaseReferenceCheck = resolve; });
  const db = {
    pool: {
      query: async (query, values) => {
        if (/SELECT id, blob_key, generation/.test(query)) return { rows: [{ ...queued }] };
        if (/SELECT EXISTS/.test(query)) {
          referenceCheckStarted();
          await gate;
          return { rows: [{ referenced: true }] };
        }
        if (/DELETE FROM blob_cleanup_queue/.test(query)) {
          if (queued && queued.id === values[0] && queued.generation === values[1]) queued = null;
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${query}`);
      }
    }
  };

  const retry = retryQueuedBlobDeletes(
    db,
    "customer-logos",
    1,
    fakeStore(async () => {})
  );
  await started;
  queued.generation = 2; // concurrent upsert creates a newer destructive intent
  releaseReferenceCheck();
  await retry;

  assert.equal(queued?.generation, 2);
});

test("cleanup retry is attached to waitUntil instead of blocking the response", async () => {
  let waited;
  const context = {
    deploy: { context: "production", published: true },
    waitUntil(promise) { waited = promise; }
  };
  const db = {
    pool: {
      query: async query => {
        if (/FROM blob_cleanup_queue/.test(query)) return { rows: [] };
        throw new Error(`Unexpected SQL: ${query}`);
      }
    }
  };

  const storeFactory = fakeStore(async () => {});
  assert.equal(scheduleBlobCleanup(context, db, "customer-logos", storeFactory), true);
  assert.ok(waited instanceof Promise);
  assert.deepEqual(await waited, { deleted: 0, retained: 0, pending: 0 });
  assert.equal(scheduleBlobCleanup({
    deploy: { context: "deploy-preview", published: false },
    waitUntil() { throw new Error("preview cleanup must not be scheduled"); }
  }, db, "customer-logos", storeFactory), false);
  assert.equal(scheduleBlobCleanup(null, db, "customer-logos", storeFactory), false);
});

test("multi-Blob cleanup attempts every key even when one cleanup throws", async () => {
  const attempted = [];
  const deleteOne = async (_db, _storeName, blobKey) => {
    attempted.push(blobKey);
    if (blobKey === "first") throw new Error("queue unavailable");
    return blobKey !== "second";
  };

  await assert.rejects(
    deleteBlobsOrQueue(
      {},
      "completed-projects",
      ["first", "second", "third"],
      "rollback",
      fakeStore(async () => {}),
      deleteOne
    ),
    error => error instanceof AggregateError && error.errors.length === 1
  );
  assert.deepEqual(attempted, ["first", "second", "third"]);
});

test("cleanup intent for every key is persisted in one query before remote work", async () => {
  const calls = [];
  const queryable = {
    async query(query, values) {
      calls.push({ query, values });
      return { rows: [] };
    }
  };

  assert.equal(
    await queueBlobCleanupIntents(
      queryable,
      "completed-projects",
      ["key-a", "key-b", "key-a"],
      "new-image-pending",
      5
    ),
    2
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /INSERT INTO blob_cleanup_queue/);
  assert.match(calls[0].query, /LEAST\(blob_cleanup_queue\.next_attempt_at/);
  assert.match(calls[0].query, /generation = blob_cleanup_queue\.generation \+ 1/);
  assert.deepEqual(calls[0].values, [
    "completed-projects",
    "new-image-pending",
    5,
    "key-a",
    "key-b"
  ]);

  await makeBlobCleanupDue(queryable, "completed-projects", ["key-a", "key-b"]);
  await clearBlobCleanupIntents(
    queryable,
    "completed-projects",
    ["key-a", "key-b"],
    "new-image-pending"
  );
  assert.match(calls[1].query, /SET next_attempt_at = NOW\(\)/);
  assert.match(calls[2].query, /DELETE FROM blob_cleanup_queue/);
  assert.match(calls[2].query, /AND reason = \$3/);
  assert.equal(calls[2].values[2], "new-image-pending");
});
