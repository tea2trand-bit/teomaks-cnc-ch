import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";
import {
  decodeImageDataUrl,
  MAX_PROJECT_IMAGE_BYTES,
  validateProjectImages
} from "./_shared/images.js";
import {
  clearBlobCleanupIntents,
  makeBlobCleanupDue,
  queueBlobCleanupIntents,
  scheduleBlobCleanup
} from "./_shared/blob-cleanup.js";
import { isPublishedProductionDeploy } from "./_shared/deploy-context.js";
import { jsonResponse, responseHeaders, textResponse } from "./_shared/http.js";

function projectStore() {
  return getStore({ name: "completed-projects", consistency: "strong" });
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

async function insertImageInTransaction(db, client, store, storedKeys, projectId, decoded, altText = "") {
  const key = `project-${crypto.randomUUID()}`;
  storedKeys.push(key);
  await queueBlobCleanupIntents(
    db.pool,
    "completed-projects",
    [key],
    "new-image-pending",
    5
  );
  await store.set(key, toArrayBuffer(decoded.bytes));
  const nextResult = await client.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
     FROM completed_project_images
     WHERE project_id = $1`,
    [projectId]
  );
  const insertResult = await client.query(
    `INSERT INTO completed_project_images (project_id, blob_key, content_type, alt_text, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [projectId, key, decoded.contentType, cleanText(altText, 300), nextResult.rows[0].next]
  );
  return { id: insertResult.rows[0].id, key };
}

export default async function handler(req, context) {
  const db = getDatabase();
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.has("image")) {
    const id = Number(url.searchParams.get("image"));
    if (!Number.isInteger(id)) return jsonResponse({ error: "Bad request" }, 400);
    const rows = await db.sql`SELECT blob_key, asset_url, content_type FROM completed_project_images WHERE id = ${id}`;
    if (!rows.length) return textResponse("Not found", 404);
    if (!rows[0].blob_key && rows[0].asset_url) {
      return new Response(null, {
        status: 302,
        headers: responseHeaders({ Location: rows[0].asset_url, "Cache-Control": "no-store" })
      });
    }
    const blob = await projectStore().get(rows[0].blob_key, { type: "arrayBuffer" });
    if (!blob) return textResponse("Not found", 404);
    return new Response(blob, {
      status: 200,
      headers: responseHeaders({
        "Content-Type": rows[0].content_type || "image/jpeg",
        "Cache-Control": "public, max-age=0, must-revalidate"
      })
    });
  }

  if (req.method === "GET") {
    const includeInactive = url.searchParams.get("all") === "1" && isAuthorized(req);
    return jsonResponse({ projects: await listProjects(db, includeInactive) });
  }

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  if (!getAdminPassword()) return jsonResponse({ error: "Admin password is not configured" }, 500);
  if (!isAuthorized(req)) return jsonResponse({ error: "Unauthorized" }, 401);

  const action = url.searchParams.get("action") || "";
  if (!isPublishedProductionDeploy(context)) {
    return jsonResponse(
      { error: "Media management is disabled outside the published production deploy" },
      403
    );
  }
  const mutationResponse = body => {
    scheduleBlobCleanup(context, db, "completed-projects", projectStore);
    return jsonResponse(body);
  };
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Bad request" }, 400);
  }

  if (action === "create" || action === "update") {
    const title = cleanText(body.title, 200);
    if (!title) return jsonResponse({ error: "Title required" }, 400);
    const values = {
      title,
      summary: cleanText(body.summary),
      description: cleanText(body.description),
      date: cleanText(body.date, 120) || null,
      location: cleanText(body.location, 200) || null,
      customer: cleanText(body.customer, 200) || null
    };

    let id = Number(body.id);
    const images = Array.isArray(body.images) ? body.images : [];
    if (action === "create" && !images.length) {
      return jsonResponse({ error: "At least one image required" }, 400);
    }
    const decodedImages = validateProjectImages(images);
    if (!decodedImages) {
      return jsonResponse({ error: "Invalid image or total image payload exceeds 4 MiB" }, 400);
    }

    if (action === "update" && !Number.isInteger(id)) {
      return jsonResponse({ error: "Bad request" }, 400);
    }

    const client = await db.pool.connect();
    const store = projectStore();
    const storedKeys = [];
    try {
      await client.query("BEGIN");
      if (action === "create") {
        const active = body.active !== false;
        // Keep append order deterministic when two create requests overlap.
        await client.query("LOCK TABLE completed_projects IN SHARE ROW EXCLUSIVE MODE");
        const nextResult = await client.query(
          "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM completed_projects"
        );
        const result = await client.query(
          `INSERT INTO completed_projects
             (title, summary, description, project_date, location, customer, active, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            values.title,
            values.summary,
            values.description,
            values.date,
            values.location,
            values.customer,
            active,
            nextResult.rows[0].next
          ]
        );
        id = result.rows[0].id;
      } else {
        const result = await client.query(
          `UPDATE completed_projects
           SET title = $1, summary = $2, description = $3,
               project_date = $4, location = $5, customer = $6
           WHERE id = $7
           RETURNING id`,
          [
            values.title,
            values.summary,
            values.description,
            values.date,
            values.location,
            values.customer,
            id
          ]
        );
        if (!result.rows.length) {
          await client.query("ROLLBACK");
          return jsonResponse({ error: "Not found" }, 404);
        }
      }

      for (const decoded of decodedImages) {
        await insertImageInTransaction(db, client, store, storedKeys, id, decoded, title);
      }
      await clearBlobCleanupIntents(
        client,
        "completed-projects",
        storedKeys,
        "new-image-pending"
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Project transaction rollback failed", rollbackError);
      }
      try {
        await makeBlobCleanupDue(db.pool, "completed-projects", storedKeys);
      } catch (cleanupError) {
        console.error("Could not accelerate project rollback cleanup", cleanupError);
      }
      scheduleBlobCleanup(context, db, "completed-projects", projectStore);
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true, id });
  }

  if (action === "add-image") {
    const id = Number(body.id);
    const decoded = decodeImageDataUrl(body.image, MAX_PROJECT_IMAGE_BYTES);
    if (!Number.isInteger(id) || !decoded) return jsonResponse({ error: "Invalid image" }, 400);
    const client = await db.pool.connect();
    const storedKeys = [];
    let inserted;
    try {
      await client.query("BEGIN");
      const project = await client.query(
        "SELECT id, title FROM completed_projects WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!project.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ error: "Not found" }, 404);
      }
      inserted = await insertImageInTransaction(
        db,
        client,
        projectStore(),
        storedKeys,
        id,
        decoded,
        body.altText || project.rows[0].title
      );
      await clearBlobCleanupIntents(
        client,
        "completed-projects",
        storedKeys,
        "new-image-pending"
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Project image transaction rollback failed", rollbackError);
      }
      try {
        await makeBlobCleanupDue(db.pool, "completed-projects", storedKeys);
      } catch (cleanupError) {
        console.error("Could not accelerate image rollback cleanup", cleanupError);
      }
      scheduleBlobCleanup(context, db, "completed-projects", projectStore);
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true, imageId: inserted.id });
  }

  if (action === "replace-image") {
    const imageId = Number(body.imageId);
    const decoded = decodeImageDataUrl(body.image, MAX_PROJECT_IMAGE_BYTES);
    if (!Number.isInteger(imageId) || !decoded) {
      return jsonResponse({ error: "Invalid image" }, 400);
    }
    const client = await db.pool.connect();
    const store = projectStore();
    const newKey = `project-${crypto.randomUUID()}`;
    let oldKey;
    let blobMayExist = false;
    try {
      await client.query("BEGIN");
      const owner = await client.query(
        "SELECT project_id FROM completed_project_images WHERE id = $1",
        [imageId]
      );
      if (!owner.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ error: "Not found" }, 404);
      }
      const projectId = owner.rows[0].project_id;
      const project = await client.query(
        "SELECT id FROM completed_projects WHERE id = $1 FOR UPDATE",
        [projectId]
      );
      if (!project.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ error: "Not found" }, 404);
      }
      const current = await client.query(
        "SELECT blob_key FROM completed_project_images WHERE id = $1 FOR UPDATE",
        [imageId]
      );
      if (!current.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ error: "Not found" }, 404);
      }
      oldKey = current.rows[0].blob_key;
      await queueBlobCleanupIntents(
        db.pool,
        "completed-projects",
        [newKey],
        "replace-image-pending",
        5
      );
      await queueBlobCleanupIntents(
        client,
        "completed-projects",
        oldKey ? [oldKey] : [],
        "replace-image-old-blob"
      );
      blobMayExist = true;
      await store.set(newKey, toArrayBuffer(decoded.bytes));
      await client.query(
        `UPDATE completed_project_images
         SET blob_key = $1, asset_url = NULL, content_type = $2
         WHERE id = $3`,
        [newKey, decoded.contentType, imageId]
      );
      await clearBlobCleanupIntents(
        client,
        "completed-projects",
        [newKey],
        "replace-image-pending"
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Project image replacement rollback failed", rollbackError);
      }
      if (blobMayExist) {
        try {
          await makeBlobCleanupDue(db.pool, "completed-projects", [newKey]);
        } catch (cleanupError) {
          console.error("Could not accelerate replacement image cleanup", cleanupError);
        }
      }
      scheduleBlobCleanup(context, db, "completed-projects", projectStore);
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true, cleanupPending: Boolean(oldKey) });
  }

  if (action === "delete-image") {
    const imageId = Number(body.imageId);
    if (!Number.isInteger(imageId)) return jsonResponse({ error: "Bad request" }, 400);
    const client = await db.pool.connect();
    let oldKey;
    try {
      await client.query("BEGIN");
      const owner = await client.query(
        "SELECT project_id FROM completed_project_images WHERE id = $1",
        [imageId]
      );
      if (!owner.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ ok: true, cleanupPending: false });
      }
      const project = await client.query(
        "SELECT id FROM completed_projects WHERE id = $1 FOR UPDATE",
        [owner.rows[0].project_id]
      );
      if (!project.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ ok: true, cleanupPending: false });
      }
      const current = await client.query(
        "SELECT blob_key FROM completed_project_images WHERE id = $1 FOR UPDATE",
        [imageId]
      );
      if (!current.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ ok: true, cleanupPending: false });
      }
      oldKey = current.rows[0].blob_key;
      await queueBlobCleanupIntents(
        client,
        "completed-projects",
        oldKey ? [oldKey] : [],
        "delete-image"
      );
      await client.query("DELETE FROM completed_project_images WHERE id = $1", [imageId]);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Project image delete rollback failed", rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true, cleanupPending: Boolean(oldKey) });
  }

  if (action === "delete") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return jsonResponse({ error: "Bad request" }, 400);
    const client = await db.pool.connect();
    let keys = [];
    try {
      await client.query("BEGIN");
      const project = await client.query(
        "SELECT id FROM completed_projects WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!project.rows.length) {
        await client.query("ROLLBACK");
        return jsonResponse({ ok: true, cleanupPending: false });
      }
      const images = await client.query(
        `SELECT blob_key FROM completed_project_images
         WHERE project_id = $1
         ORDER BY id
         FOR UPDATE`,
        [id]
      );
      keys = images.rows.map(image => image.blob_key).filter(Boolean);
      await queueBlobCleanupIntents(
        client,
        "completed-projects",
        keys,
        "delete-project"
      );
      await client.query("DELETE FROM completed_projects WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Project delete rollback failed", rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
    return mutationResponse({ ok: true, cleanupPending: keys.length > 0 });
  }

  if (action === "toggle") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return jsonResponse({ error: "Bad request" }, 400);
    const rows = await db.sql`UPDATE completed_projects SET active = NOT active WHERE id = ${id} RETURNING active`;
    if (!rows.length) return jsonResponse({ error: "Not found" }, 404);
    return mutationResponse({ ok: true, active: rows[0].active });
  }

  if (action === "reorder") {
    const ids = [...new Set(
      (Array.isArray(body.order) ? body.order : []).map(Number).filter(Number.isInteger)
    )];
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const lockIds = [...ids].sort((a, b) => a - b);
      if (lockIds.length) {
        await client.query(
          "SELECT id FROM completed_projects WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
          [lockIds]
        );
      }
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
    return mutationResponse({ ok: true });
  }

  return jsonResponse({ error: "Unknown action" }, 400);
}
