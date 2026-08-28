import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";
import { decodeImageDataUrl, MAX_LOGO_BYTES } from "./_shared/images.js";
import {
  clearBlobCleanupIntents,
  makeBlobCleanupDue,
  queueBlobCleanupIntents,
  scheduleBlobCleanup
} from "./_shared/blob-cleanup.js";
import { jsonResponse, responseHeaders, textResponse } from "./_shared/http.js";

// The logo image bytes are stored in Netlify Blobs. Strong consistency means a
// freshly uploaded or replaced logo is visible immediately, with no stale-read
// window for visitors.
function logoStore() {
  return getStore({ name: "customer-logos", consistency: "strong" });
}

function getAdminPassword() {
  const value = typeof Netlify !== "undefined"
    ? Netlify.env.get("ADMIN_PASSWORD")
    : process.env.ADMIN_PASSWORD;
  const adminPassword = (value || "").trim();
  return adminPassword || null;
}

function isAuthorized(req) {
  const adminPassword = getAdminPassword();
  if (!adminPassword) return false;
  const provided = (req.headers.get("x-admin-password") || "").trim();
  return provided === adminPassword;
}

export default async function handler(req, context) {
  const db = getDatabase();
  const url = new URL(req.url);

  // ---- Serve a single logo image (public). ------------------------------
  // Used as the `src` of the <img> tags on the public site and in the admin.
  if (req.method === "GET" && url.searchParams.has("image")) {
    const id = Number(url.searchParams.get("image"));
    if (!Number.isInteger(id)) return jsonResponse({ error: "Bad request" }, 400);

    const rows = await db.sql`SELECT blob_key, asset_url, content_type FROM customer_logos WHERE id = ${id}`;
    if (!rows.length) return textResponse("Not found", 404);

    // Built-in logos have no blob; their bytes ship as a static asset. Point
    // the caller straight at that file.
    if (!rows[0].blob_key && rows[0].asset_url) {
      return new Response(null, {
        status: 302,
        headers: responseHeaders({ Location: rows[0].asset_url, "Cache-Control": "no-store" })
      });
    }

    const blob = await logoStore().get(rows[0].blob_key, { type: "arrayBuffer" });
    if (!blob) return textResponse("Not found", 404);

    return new Response(blob, {
      status: 200,
      headers: responseHeaders({
        "Content-Type": rows[0].content_type || "image/png",
        // Logos change rarely; let the browser cache but always revalidate.
        "Cache-Control": "public, max-age=0, must-revalidate"
      })
    });
  }

  // ---- List logos (JSON). ----------------------------------------------
  // Public callers get only active logos; the admin panel passes the password
  // (and ?all=1) to receive inactive ones too.
  if (req.method === "GET") {
    const wantAll = url.searchParams.get("all") === "1" && isAuthorized(req);
    const rows = wantAll
      ? await db.sql`SELECT id, active, sort_order, asset_url FROM customer_logos ORDER BY sort_order, id`
      : await db.sql`SELECT id, active, sort_order, asset_url FROM customer_logos WHERE active = TRUE ORDER BY sort_order, id`;

    const logos = rows.map(r => ({
      id: r.id,
      active: r.active,
      sortOrder: r.sort_order,
      // Built-in logos resolve straight to their static asset; uploaded ones
      // are streamed back through this same function by id.
      url: r.asset_url || `/.netlify/functions/customer-logos?image=${r.id}`
    }));
    return jsonResponse({ logos });
  }

  // ---- Everything below mutates data and requires the admin password. ----
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  }
  if (!getAdminPassword()) {
    return jsonResponse({ error: "Admin password is not configured" }, 500);
  }
  if (!isAuthorized(req)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const action = url.searchParams.get("action") || "";

  // Lightweight password check used by the admin login screen.
  if (action === "verify") {
    return jsonResponse({ ok: true });
  }

  const mutationResponse = body => {
    scheduleBlobCleanup(context, db, "customer-logos", logoStore);
    return jsonResponse(body);
  };

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Bad request" }, 400);
  }

  // Create a new logo from an uploaded image.
  if (action === "create") {
    const decoded = decodeImageDataUrl(body && body.image, MAX_LOGO_BYTES);
    if (!decoded) {
      return jsonResponse({ error: "Invalid image" }, 400);
    }
    const key = `logo-${crypto.randomUUID()}`;
    const store = logoStore();
    await queueBlobCleanupIntents(db.pool, "customer-logos", [key], "create-pending", 5);
    const client = await db.pool.connect();
    let createdId;
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE customer_logos IN SHARE ROW EXCLUSIVE MODE");
      const nextResult = await client.query(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM customer_logos"
      );
      await store.set(key, decoded.bytes);
      const result = await client.query(
        `INSERT INTO customer_logos (blob_key, content_type, sort_order)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [key, decoded.contentType, nextResult.rows[0].next]
      );
      await clearBlobCleanupIntents(client, "customer-logos", [key], "create-pending");
      await client.query("COMMIT");
      createdId = result.rows[0].id;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Customer logo transaction rollback failed", rollbackError);
      }
      try {
        await makeBlobCleanupDue(db.pool, "customer-logos", [key]);
      } catch (cleanupError) {
        console.error("Could not accelerate pending logo cleanup", cleanupError);
      }
      scheduleBlobCleanup(context, db, "customer-logos", logoStore);
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true, id: createdId });
  }

  // Replace the image of an existing logo, keeping its position and state.
  if (action === "replace") {
    const id = Number(body && body.id);
    const decoded = decodeImageDataUrl(body && body.image, MAX_LOGO_BYTES);
    if (!Number.isInteger(id) || !decoded) {
      return jsonResponse({ error: "Invalid image" }, 400);
    }
    const newKey = `logo-${crypto.randomUUID()}`;
    const client = await db.pool.connect();
    const store = logoStore();
    let oldKey;
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT blob_key FROM customer_logos WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!current.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ error: "Not found" }, 404);
      }
      oldKey = current.rows[0].blob_key;
      await queueBlobCleanupIntents(
        db.pool,
        "customer-logos",
        [newKey],
        "replace-pending",
        5
      );
      await queueBlobCleanupIntents(
        client,
        "customer-logos",
        oldKey ? [oldKey] : [],
        "replace-old-blob"
      );
      await store.set(newKey, decoded.bytes);
      await client.query(
        `UPDATE customer_logos
         SET content_type = $1, blob_key = $2, asset_url = NULL
         WHERE id = $3`,
        [decoded.contentType, newKey, id]
      );
      await clearBlobCleanupIntents(client, "customer-logos", [newKey], "replace-pending");
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Customer logo replacement rollback failed", rollbackError);
      }
      try {
        await makeBlobCleanupDue(db.pool, "customer-logos", [newKey]);
      } catch (cleanupError) {
        console.error("Could not accelerate replacement Blob cleanup", cleanupError);
      }
      scheduleBlobCleanup(context, db, "customer-logos", logoStore);
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true, cleanupPending: Boolean(oldKey) });
  }

  // Delete a logo and its stored image.
  if (action === "delete") {
    const id = Number(body && body.id);
    if (!Number.isInteger(id)) return jsonResponse({ error: "Bad request" }, 400);
    const client = await db.pool.connect();
    let oldKey;
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT blob_key FROM customer_logos WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!current.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ ok: true, cleanupPending: false });
      }
      oldKey = current.rows[0].blob_key;
      await queueBlobCleanupIntents(
        client,
        "customer-logos",
        oldKey ? [oldKey] : [],
        "delete-logo"
      );
      await client.query("DELETE FROM customer_logos WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Customer logo delete rollback failed", rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true, cleanupPending: Boolean(oldKey) });
  }

  // Flip the active / inactive flag.
  if (action === "toggle") {
    const id = Number(body && body.id);
    if (!Number.isInteger(id)) return jsonResponse({ error: "Bad request" }, 400);
    const rows = await db.sql`
      UPDATE customer_logos SET active = NOT active WHERE id = ${id} RETURNING active`;
    if (!rows.length) return jsonResponse({ error: "Not found" }, 404);
    return mutationResponse({ ok: true, active: rows[0].active });
  }

  // Persist a new order. Body: { order: [id, id, ...] } top-to-bottom.
  if (action === "reorder") {
    const order = Array.isArray(body && body.order) ? body.order : null;
    if (!order) return jsonResponse({ error: "Bad request" }, 400);
    const ids = [...new Set(order.map(Number).filter(Number.isInteger))];

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const lockIds = [...ids].sort((a, b) => a - b);
      if (lockIds.length) {
        await client.query(
          "SELECT id FROM customer_logos WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
          [lockIds]
        );
      }
      for (let i = 0; i < ids.length; i++) {
        await client.query(
          "UPDATE customer_logos SET sort_order = $1 WHERE id = $2",
          [i + 1, ids[i]]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true });
  }

  return jsonResponse({ error: "Unknown action" }, 400);
}
