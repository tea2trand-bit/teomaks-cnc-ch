import { getDatabase } from "@netlify/database";
import { bookedSetsEqual, cleanBooked, parseBookedInput } from "./_shared/availability.js";
import { jsonResponse } from "./_shared/http.js";

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

export default async function handler(req) {
  const db = getDatabase();

  // Read the current availability from the database — the single, shared
  // source of truth, identical for every visitor and every device.
  if (req.method === "GET") {
    const rows = await db.sql`SELECT booked_date FROM availability ORDER BY booked_date`;
    return jsonResponse({ booked: cleanBooked(rows.map(r => r.booked_date)) });
  }

  if (req.method === "POST") {
    if (!getAdminPassword()) {
      return jsonResponse({ error: "Admin password is not configured" }, 500);
    }
    if (!isAuthorized(req)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Login can verify the password without writing any data.
    if (new URL(req.url).searchParams.get("verify") === "1") {
      return jsonResponse({ ok: true });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Bad request" }, 400);
    }
    const booked = parseBookedInput(body && body.booked);
    const baseBooked = parseBookedInput(body && body.baseBooked);
    if (!booked || !baseBooked) {
      return jsonResponse({ error: "booked and baseBooked must contain valid ISO dates" }, 400);
    }

    // The admin edits a complete snapshot. Lock and compare its original
    // snapshot before replacing anything so a stale tab cannot overwrite a
    // newer schedule written by another admin session.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE availability IN EXCLUSIVE MODE");
      const currentRows = await client.query(
        "SELECT booked_date FROM availability ORDER BY booked_date"
      );
      const currentBooked = cleanBooked(currentRows.rows.map(row => row.booked_date));
      if (!bookedSetsEqual(currentBooked, baseBooked)) {
        await client.query("ROLLBACK");
        return jsonResponse({
          error: "Availability changed since it was loaded",
          booked: currentBooked
        }, 409);
      }
      await client.query("DELETE FROM availability");
      if (booked.length) {
        const placeholders = booked.map((_, i) => `($${i + 1})`).join(",");
        await client.query(
          `INSERT INTO availability (booked_date) VALUES ${placeholders}`,
          booked
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return jsonResponse({ booked });
  }

  return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
}
