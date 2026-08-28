const STORE_NAMES = new Set(["customer-logos", "completed-projects"]);
const REFERENCE_QUERIES = {
  "customer-logos": "SELECT EXISTS (SELECT 1 FROM customer_logos WHERE blob_key = $1) AS referenced",
  "completed-projects": "SELECT EXISTS (SELECT 1 FROM completed_project_images WHERE blob_key = $1) AS referenced"
};

function errorMessage(error) {
  return String(error && error.message ? error.message : error || "Unknown error").slice(0, 1000);
}

function uniqueBlobKeys(blobKeys) {
  return [...new Set((Array.isArray(blobKeys) ? blobKeys : []).filter(Boolean))];
}

// Persist cleanup intent before a Blob write or in the same transaction that
// removes its final DB reference. A delay protects a not-yet-committed upload
// from another request's cleanup worker.
export async function queueBlobCleanupIntents(
  queryable,
  storeName,
  blobKeys,
  reason,
  delayMinutes = 0
) {
  if (!STORE_NAMES.has(storeName)) throw new Error("Unsupported Blob store");
  if (!queryable || typeof queryable.query !== "function") throw new Error("Queryable required");
  if (!Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > 60) {
    throw new Error("Invalid cleanup delay");
  }
  const keys = uniqueBlobKeys(blobKeys);
  if (!keys.length) return 0;
  const values = [storeName, String(reason || "").slice(0, 300), delayMinutes, ...keys];
  const rows = keys.map((_, index) => (
    `($1, $${index + 4}, $2, 0, NULL, NOW(), NOW() + ($3 * INTERVAL '1 minute'))`
  )).join(",");
  await queryable.query(
    `INSERT INTO blob_cleanup_queue
       (store_name, blob_key, reason, attempts, last_error, updated_at, next_attempt_at)
     VALUES ${rows}
     ON CONFLICT (store_name, blob_key) DO UPDATE
     SET reason = EXCLUDED.reason,
         updated_at = NOW(),
         next_attempt_at = LEAST(blob_cleanup_queue.next_attempt_at, EXCLUDED.next_attempt_at),
         generation = blob_cleanup_queue.generation + 1`,
    values
  );
  return keys.length;
}

export async function clearBlobCleanupIntents(queryable, storeName, blobKeys, expectedReason) {
  if (!STORE_NAMES.has(storeName)) throw new Error("Unsupported Blob store");
  if (typeof expectedReason !== "string" || !expectedReason) {
    throw new Error("Expected cleanup reason required");
  }
  const keys = uniqueBlobKeys(blobKeys);
  if (!keys.length) return 0;
  await queryable.query(
    `DELETE FROM blob_cleanup_queue
     WHERE store_name = $1 AND blob_key = ANY($2::text[]) AND reason = $3`,
    [storeName, keys, expectedReason]
  );
  return keys.length;
}

export async function makeBlobCleanupDue(queryable, storeName, blobKeys) {
  if (!STORE_NAMES.has(storeName)) throw new Error("Unsupported Blob store");
  const keys = uniqueBlobKeys(blobKeys);
  if (!keys.length) return 0;
  await queryable.query(
    `UPDATE blob_cleanup_queue
     SET next_attempt_at = NOW(), updated_at = NOW()
     WHERE store_name = $1 AND blob_key = ANY($2::text[])`,
    [storeName, keys]
  );
  return keys.length;
}

async function queueDelete(db, storeName, blobKey, reason, error) {
  await db.pool.query(
    `INSERT INTO blob_cleanup_queue
       (store_name, blob_key, reason, attempts, last_error, updated_at, next_attempt_at)
     VALUES ($1, $2, $3, 1, $4, NOW(), NOW() + INTERVAL '1 minute')
     ON CONFLICT (store_name, blob_key) DO UPDATE
     SET reason = EXCLUDED.reason,
         attempts = blob_cleanup_queue.attempts + 1,
         last_error = EXCLUDED.last_error,
         updated_at = NOW(),
         next_attempt_at = NOW() + INTERVAL '1 minute',
         generation = blob_cleanup_queue.generation + 1`,
    [storeName, blobKey, String(reason || "").slice(0, 300), errorMessage(error)]
  );
}

export async function blobIsReferenced(db, storeName, blobKey) {
  if (!STORE_NAMES.has(storeName)) throw new Error("Unsupported Blob store");
  const result = await db.pool.query(REFERENCE_QUERIES[storeName], [blobKey]);
  return Boolean(result.rows?.[0]?.referenced);
}

// Database mutations are committed before obsolete Blob objects are removed.
// If that external deletion fails, retain the exact key in Postgres so it is
// recoverable and can be retried instead of becoming an untracked orphan.
export async function deleteBlobOrQueue(db, storeName, blobKey, reason, storeFactory) {
  if (!blobKey) return true;
  if (typeof storeFactory !== "function") throw new Error("Blob store factory required");
  try {
    // This check makes cleanup safe after an ambiguous COMMIT result: if the
    // database did commit, the newly referenced object is retained.
    if (await blobIsReferenced(db, storeName, blobKey)) return true;
  } catch (error) {
    console.error("Blob reference check failed; queuing without deleting", {
      storeName,
      blobKey,
      reason,
      error: errorMessage(error)
    });
    try {
      await queueDelete(db, storeName, blobKey, reason, error);
    } catch (queueError) {
      console.error("CRITICAL: Blob cleanup key could not be persisted", {
        storeName,
        blobKey,
        reason,
        referenceError: errorMessage(error),
        queueError: errorMessage(queueError)
      });
      throw new AggregateError([error, queueError], "Blob reference check failed and cleanup could not be queued");
    }
    return false;
  }
  try {
    await storeFactory(storeName).delete(blobKey);
    return true;
  } catch (error) {
    console.error("Blob deletion failed; queuing retry", {
      storeName,
      blobKey,
      reason,
      error: errorMessage(error)
    });
    try {
      await queueDelete(db, storeName, blobKey, reason, error);
    } catch (queueError) {
      console.error("CRITICAL: Blob cleanup key could not be persisted", {
        storeName,
        blobKey,
        reason,
        deleteError: errorMessage(error),
        queueError: errorMessage(queueError)
      });
      throw new AggregateError([error, queueError], "Blob cleanup failed and could not be queued");
    }
    return false;
  }
}

export async function deleteBlobsOrQueue(
  db,
  storeName,
  blobKeys,
  reason,
  storeFactory,
  deleteOne = deleteBlobOrQueue
) {
  let queued = 0;
  const errors = [];
  for (const blobKey of blobKeys) {
    try {
      if (!await deleteOne(db, storeName, blobKey, reason, storeFactory)) queued += 1;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, `Cleanup failed for ${errors.length} Blob(s)`);
  }
  return { queued, processed: blobKeys.length };
}

// Retry a small, rotating batch after successful admin mutations. Failed rows
// move into the future so a permanently bad object cannot starve newer work.
export async function retryQueuedBlobDeletes(db, storeName, limit = 1, storeFactory) {
  if (!STORE_NAMES.has(storeName)) throw new Error("Unsupported Blob store");
  if (typeof storeFactory !== "function") throw new Error("Blob store factory required");
  let rows;
  try {
    const result = await db.pool.query(
      `SELECT id, blob_key, generation
       FROM blob_cleanup_queue
       WHERE store_name = $1 AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at, id
       LIMIT $2`,
      [storeName, limit]
    );
    rows = result.rows || [];
  } catch (error) {
    // This runs after the HTTP response. No key is lost if the queue itself is
    // temporarily unavailable: existing rows remain durable in Postgres.
    console.error("Blob cleanup retry query failed", { storeName, error: errorMessage(error) });
    return { deleted: 0, retained: 0, pending: null };
  }

  let deleted = 0;
  let retained = 0;
  for (const row of rows) {
    try {
      if (await blobIsReferenced(db, storeName, row.blob_key)) {
        await db.pool.query(
          "DELETE FROM blob_cleanup_queue WHERE id = $1 AND generation = $2",
          [row.id, row.generation]
        );
        retained += 1;
        continue;
      }
      await storeFactory(storeName).delete(row.blob_key);
      await db.pool.query(
        "DELETE FROM blob_cleanup_queue WHERE id = $1 AND generation = $2",
        [row.id, row.generation]
      );
      deleted += 1;
    } catch (error) {
      console.error("Queued Blob deletion still failing", {
        storeName,
        blobKey: row.blob_key,
        error: errorMessage(error)
      });
      await db.pool.query(
        `UPDATE blob_cleanup_queue
         SET attempts = attempts + 1,
             last_error = $1,
             updated_at = NOW(),
             next_attempt_at = NOW() + (LEAST(attempts + 1, 60) * INTERVAL '1 minute')
         WHERE id = $2 AND generation = $3`,
        [errorMessage(error), row.id, row.generation]
      ).catch(updateError => {
        console.error("Blob cleanup retry status update failed", {
          storeName,
          blobKey: row.blob_key,
          error: errorMessage(updateError)
        });
      });
    }
  }
  return { deleted, retained, pending: rows.length - deleted - retained };
}

// Netlify's waitUntil sends the HTTP response first, then lets one bounded
// cleanup retry finish in the remaining function lifetime. Cleanup therefore
// never blocks login or the primary admin write path.
export function scheduleBlobCleanup(context, db, storeName, storeFactory) {
  if (!isPublishedProductionDeploy(context)) return false;
  if (!context || typeof context.waitUntil !== "function") return false;
  const task = retryQueuedBlobDeletes(db, storeName, 1, storeFactory).catch(error => {
    console.error("Deferred Blob cleanup failed", { storeName, error: errorMessage(error) });
  });
  try {
    context.waitUntil(task);
    return true;
  } catch (error) {
    console.error("Could not attach deferred Blob cleanup", { storeName, error: errorMessage(error) });
    return false;
  }
}
import { isPublishedProductionDeploy } from "./deploy-context.js";
