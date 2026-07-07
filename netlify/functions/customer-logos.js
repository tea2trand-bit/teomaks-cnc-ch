import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";

// CORS so both the public site and the admin panel can call this function.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

// The logo image bytes are stored in Netlify Blobs. Strong consistency means a
// freshly uploaded or replaced logo is visible immediately, with no stale-read
// window for visitors.
function logoStore() {
  return getStore({ name: "customer-logos", consistency: "strong" });
}

function isAuthorized(req) {
  const adminPassword = (process.env.ADMIN_PASSWORD || "teomaks2026").trim();
  const provided = (req.headers.get("x-admin-password") || "").trim();
  return provided === adminPassword;
}

// Only a small set of web-safe raster/vector image types is accepted for a logo.
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif"
]);

// Decode a `data:` URL (as produced by FileReader.readAsDataURL in the admin UI)
// into raw bytes plus its declared content type.
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const contentType = (match[1] || "application/octet-stream").toLowerCase();
  const isBase64 = Boolean(match[2]);
  const data = match[3] || "";
  if (!isBase64) return null;
  let bytes;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return null;
  }
  return { contentType, bytes };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const db = getDatabase();
  const url = new URL(req.url);

  // ---- Serve a single logo image (public). ------------------------------
  // Used as the `src` of the <img> tags on the public site and in the admin.
  if (req.method === "GET" && url.searchParams.has("image")) {
    const id = Number(url.searchParams.get("image"));
    if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);

    const rows = await db.sql`SELECT blob_key, asset_url, content_type FROM customer_logos WHERE id = ${id}`;
    if (!rows.length) return new Response("Not found", { status: 404, headers: CORS });

    // Built-in logos have no blob; their bytes ship as a static asset. Point
    // the caller straight at that file.
    if (!rows[0].blob_key && rows[0].asset_url) {
      return new Response(null, {
        status: 302,
        headers: { Location: rows[0].asset_url, ...CORS }
      });
    }

    const blob = await logoStore().get(rows[0].blob_key, { type: "arrayBuffer" });
    if (!blob) return new Response("Not found", { status: 404, headers: CORS });

    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": rows[0].content_type || "image/png",
        // Logos change rarely; let the browser cache but always revalidate.
        "Cache-Control": "public, max-age=0, must-revalidate",
        ...CORS
      }
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
    return json({ logos });
  }

  // ---- Everything below mutates data and requires the admin password. ----
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!isAuthorized(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const action = url.searchParams.get("action") || "";

  // Lightweight password check used by the admin login screen.
  if (action === "verify") {
    return json({ ok: true });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  // Create a new logo from an uploaded image.
  if (action === "create") {
    const decoded = decodeDataUrl(body && body.image);
    if (!decoded || !ALLOWED_TYPES.has(decoded.contentType)) {
      return json({ error: "Invalid image" }, 400);
    }
    const key = `logo-${crypto.randomUUID()}`;
    await logoStore().set(key, decoded.bytes);

    // Append to the end of the current order.
    const [{ next }] = await db.sql`
      SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM customer_logos`;
    const rows = await db.sql`
      INSERT INTO customer_logos (blob_key, content_type, sort_order)
      VALUES (${key}, ${decoded.contentType}, ${next})
      RETURNING id`;
    return json({ ok: true, id: rows[0].id });
  }

  // Replace the image of an existing logo, keeping its position and state.
  if (action === "replace") {
    const id = Number(body && body.id);
    const decoded = decodeDataUrl(body && body.image);
    if (!Number.isInteger(id) || !decoded || !ALLOWED_TYPES.has(decoded.contentType)) {
      return json({ error: "Invalid image" }, 400);
    }
    const rows = await db.sql`SELECT blob_key FROM customer_logos WHERE id = ${id}`;
    if (!rows.length) return json({ error: "Not found" }, 404);

    // A built-in logo starts with no blob (its bytes are a static asset); mint
    // a key on first replace and detach it from the static asset.
    const key = rows[0].blob_key || `logo-${crypto.randomUUID()}`;
    await logoStore().set(key, decoded.bytes);
    await db.sql`
      UPDATE customer_logos
      SET content_type = ${decoded.contentType}, blob_key = ${key}, asset_url = NULL
      WHERE id = ${id}`;
    return json({ ok: true });
  }

  // Delete a logo and its stored image.
  if (action === "delete") {
    const id = Number(body && body.id);
    if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);
    const rows = await db.sql`SELECT blob_key FROM customer_logos WHERE id = ${id}`;
    if (rows.length) {
      // Built-in (asset-backed) logos have no blob to remove.
      if (rows[0].blob_key) await logoStore().delete(rows[0].blob_key);
      await db.sql`DELETE FROM customer_logos WHERE id = ${id}`;
    }
    return json({ ok: true });
  }

  // Flip the active / inactive flag.
  if (action === "toggle") {
    const id = Number(body && body.id);
    if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);
    const rows = await db.sql`
      UPDATE customer_logos SET active = NOT active WHERE id = ${id} RETURNING active`;
    if (!rows.length) return json({ error: "Not found" }, 404);
    return json({ ok: true, active: rows[0].active });
  }

  // Persist a new order. Body: { order: [id, id, ...] } top-to-bottom.
  if (action === "reorder") {
    const order = Array.isArray(body && body.order) ? body.order : null;
    if (!order) return json({ error: "Bad request" }, 400);
    const ids = order.map(Number).filter(Number.isInteger);

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
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
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
}
