import { getStore } from "@netlify/blobs";
import { getDatabase } from "@netlify/database";
import { retryQueuedBlobDeletes } from "./_shared/blob-cleanup.js";

function cleanupStore(storeName) {
  return getStore({ name: storeName, consistency: "strong" });
}

export default async function handler() {
  const db = getDatabase();
  const results = await Promise.allSettled([
    retryQueuedBlobDeletes(db, "customer-logos", 1, cleanupStore),
    retryQueuedBlobDeletes(db, "completed-projects", 1, cleanupStore)
  ]);
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error("Scheduled Blob cleanup failed", {
        storeName: index === 0 ? "customer-logos" : "completed-projects",
        error: String(result.reason?.message || result.reason || "Unknown error")
      });
    }
  }
}

export const config = {
  schedule: "@hourly"
};
