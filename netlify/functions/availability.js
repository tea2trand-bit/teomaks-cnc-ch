import { getDatabase } from "@netlify/database";

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

function cleanBooked(input) {
  return (Array.isArray(input) ? input : [])
    .filter(d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: CORS });
  }

  const db = getDatabase();

  // Read the current availability from the database — the single, shared
  // source of truth, identical for every visitor and every device.
  if (req.method === "GET") {
    const rows = await db.sql`SELECT booked_date FROM availability ORDER BY booked_date`;
    return json({ booked: cleanBooked(rows.map(r => r.booked_date)) });
  }

  if (req.method === "POST") {
    // Trim so an accidental trailing newline/space in the env var (a common
    // cause of "Unauthorized") doesn't break an otherwise correct password.
    const adminPassword = (process.env.ADMIN_PASSWORD || "teomaks2026").trim();
    const provided = (req.headers.get("x-admin-password") || "").trim();

    if (provided !== adminPassword) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Login can verify the password without writing any data.
    if (new URL(req.url).searchParams.get("verify") === "1") {
      return json({ ok: true });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Bad request" }, 400);
    }
    const booked = cleanBooked(body && body.booked);

    // Replace the whole set inside a transaction so the saved state always
    // matches exactly what the admin submitted, with no partial writes.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
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

    return json({ booked });
  }

  return json({ error: "Method not allowed" }, 405);
}
