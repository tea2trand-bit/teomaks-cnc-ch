import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const MAX_PROJECT_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

function projectStore() {
  return getStore({ name: "completed-projects", consistency: "strong" });
}

function getAdminPassword() {
  const adminPassword = (process.env.ADMIN_PASSWORD || "").trim();
  return adminPassword || null;
}

function isAuthorized(req) {
  const adminPassword = getAdminPassword();
  if (!adminPassword) return false;
  const provided = (req.headers.get("x-admin-password") || "").trim();
  return provided === adminPassword;
}

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match || !match[2]) return null;
  const contentType = (match[1] || "application/octet-stream").toLowerCase();
  let bytes;
  try {
    bytes = Buffer.from(match[3] || "", "base64");
  } catch {
    return null;
  }
  if (bytes.length > MAX_PROJECT_IMAGE_BYTES) return null;
  return { contentType, bytes };
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function cleanText(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function rowToProject(row) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary || "",
    description: row.description || "",
    date: row.project_date || "",
    location: row.location || "",
    customer: row.customer || "",
    active: row.active,
    sortOrder: row.sort_order,
    images: []
  };
}

async function listProjects(db, includeInactive) {
  const rows = includeInactive
    ? await db.sql`SELECT * FROM completed_projects ORDER BY sort_order, id`
    : await db.sql`SELECT * FROM completed_projects WHERE active = TRUE ORDER BY sort_order, id`;
  const projects = rows.map(rowToProject);
  if (!projects.length) return projects;

  const ids = projects.map(p => p.id);
  const byId = new Map(projects.map(p => [p.id, p]));
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");
  let imageRows = [];
  try {
    const images = await db.pool.query(
      `SELECT * FROM completed_project_images WHERE project_id IN (${placeholders}) ORDER BY sort_order, id`,
      ids
    );
    imageRows = images.rows || [];
  } catch {
    imageRows = [];
  }
  for (const image of imageRows) {
    const project = byId.get(image.project_id);
    if (!project) continue;
    project.images.push({
      id: image.id,
      url: image.asset_url || `/.netlify/functions/completed-projects?image=${image.id}`,
      alt: image.alt_text || project.title,
      sortOrder: image.sort_order
    });
  }
  return projects;
}

async function insertImage(db, projectId, image, altText = "") {
  const decoded = decodeDataUrl(image);
  if (!decoded || !ALLOWED_TYPES.has(decoded.contentType)) {
    throw new Error("Invalid image");
  }
  const key = `project-${crypto.randomUUID()}`;
  await projectStore().set(key, toArrayBuffer(decoded.bytes));
  const [{ next }] = await db.sql`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
    FROM completed_project_images
    WHERE project_id = ${projectId}`;
  const rows = await db.sql`
    INSERT INTO completed_project_images (project_id, blob_key, content_type, alt_text, sort_order)
    VALUES (${projectId}, ${key}, ${decoded.contentType}, ${cleanText(altText, 300)}, ${next})
    RETURNING id`;
  return rows[0].id;
}

function validateImages(images) {
  for (const image of images) {
    const decoded = decodeDataUrl(image);
    if (!decoded || !ALLOWED_TYPES.has(decoded.contentType)) return false;
  }
  return true;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const db = getDatabase();
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.has("image")) {
    const id = Number(url.searchParams.get("image"));
    if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);
    const rows = await db.sql`SELECT blob_key, asset_url, content_type FROM completed_project_images WHERE id = ${id}`;
    if (!rows.length) return new Response("Not found", { status: 404, headers: CORS });
    if (!rows[0].blob_key && rows[0].asset_url) {
      return new Response(null, { status: 302, headers: { Location: rows[0].asset_url, ...CORS } });
    }
    const blob = await projectStore().get(rows[0].blob_key, { type: "arrayBuffer" });
    if (!blob) return new Response("Not found", { status: 404, headers: CORS });
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": rows[0].content_type || "image/jpeg",
        "Cache-Control": "public, max-age=0, must-revalidate",
        ...CORS
      }
    });
  }

  if (req.method === "GET") {
    const includeInactive = url.searchParams.get("all") === "1" && isAuthorized(req);
    return json({ projects: await listProjects(db, includeInactive) });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!getAdminPassword()) return json({ error: "Admin password is not configured" }, 500);
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  const action = url.searchParams.get("action") || "";
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  if (action === "create" || action === "update") {
    const title = cleanText(body.title, 200);
    if (!title) return json({ error: "Title required" }, 400);
    const values = {
      title,
      summary: cleanText(body.summary),
      description: cleanText(body.description),
      date: cleanText(body.date, 120) || null,
      location: cleanText(body.location, 200) || null,
      customer: cleanText(body.customer, 200) || null,
      active: body.active !== false
    };

    let id = Number(body.id);
    const images = Array.isArray(body.images) ? body.images : [];
    if (action === "create" && !images.length) {
      return json({ error: "At least one image required" }, 400);
    }
    if (!validateImages(images)) {
      return json({ error: "Invalid image" }, 400);
    }

    if (action === "create") {
      const [{ next }] = await db.sql`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM completed_projects`;
      const rows = await db.sql`
        INSERT INTO completed_projects (title, summary, description, project_date, location, customer, active, sort_order)
        VALUES (${values.title}, ${values.summary}, ${values.description}, ${values.date}, ${values.location}, ${values.customer}, ${values.active}, ${next})
        RETURNING id`;
      id = rows[0].id;
    } else {
      if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);
      const rows = await db.sql`
        UPDATE completed_projects
        SET title = ${values.title}, summary = ${values.summary}, description = ${values.description},
            project_date = ${values.date}, location = ${values.location}, customer = ${values.customer}, active = ${values.active}
        WHERE id = ${id}
        RETURNING id`;
      if (!rows.length) return json({ error: "Not found" }, 404);
    }

    try {
      for (const image of images) await insertImage(db, id, image, title);
    } catch (error) {
      if (action === "create" && Number.isInteger(id)) {
        await db.sql`DELETE FROM completed_projects WHERE id = ${id}`;
      }
      throw error;
    }
    return json({ ok: true, id });
  }

  if (action === "add-image") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);
    const exists = await db.sql`SELECT id, title FROM completed_projects WHERE id = ${id}`;
    if (!exists.length) return json({ error: "Not found" }, 404);
    return json({ ok: true, imageId: await insertImage(db, id, body.image, body.altText || exists[0].title) });
  }

  if (action === "replace-image") {
    const imageId = Number(body.imageId);
    const decoded = decodeDataUrl(body.image);
    if (!Number.isInteger(imageId) || !decoded || !ALLOWED_TYPES.has(decoded.contentType)) {
      return json({ error: "Invalid image" }, 400);
    }
    const rows = await db.sql`SELECT blob_key FROM completed_project_images WHERE id = ${imageId}`;
    if (!rows.length) return json({ error: "Not found" }, 404);
    const key = rows[0].blob_key || `project-${crypto.randomUUID()}`;
    await projectStore().set(key, toArrayBuffer(decoded.bytes));
    await db.sql`
      UPDATE completed_project_images
      SET blob_key = ${key}, asset_url = NULL, content_type = ${decoded.contentType}
      WHERE id = ${imageId}`;
    return json({ ok: true });
  }

  if (action === "delete-image") {
    const imageId = Number(body.imageId);
    if (!Number.isInteger(imageId)) return json({ error: "Bad request" }, 400);
    const rows = await db.sql`SELECT blob_key FROM completed_project_images WHERE id = ${imageId}`;
    if (rows.length) {
      if (rows[0].blob_key) await projectStore().delete(rows[0].blob_key);
      await db.sql`DELETE FROM completed_project_images WHERE id = ${imageId}`;
    }
    return json({ ok: true });
  }

  if (action === "delete") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);
    const images = await db.sql`SELECT blob_key FROM completed_project_images WHERE project_id = ${id}`;
    for (const image of images) {
      if (image.blob_key) await projectStore().delete(image.blob_key);
    }
    await db.sql`DELETE FROM completed_projects WHERE id = ${id}`;
    return json({ ok: true });
  }

  if (action === "toggle") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);
    const rows = await db.sql`UPDATE completed_projects SET active = NOT active WHERE id = ${id} RETURNING active`;
    if (!rows.length) return json({ error: "Not found" }, 404);
    return json({ ok: true, active: rows[0].active });
  }

  if (action === "reorder") {
    const ids = (Array.isArray(body.order) ? body.order : []).map(Number).filter(Number.isInteger);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < ids.length; i++) {
        await client.query("UPDATE completed_projects SET sort_order = $1 WHERE id = $2", [i + 1, ids[i]]);
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
