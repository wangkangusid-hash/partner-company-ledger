const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const PASSWORD = process.env.LEDGER_PASSWORD || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "ledger_entries";
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATA_FILE = path.join(DATA_DIR, "ledger.json");
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(url, response);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "server_error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ledger app running at http://${HOST}:${PORT}`);
  if (!PASSWORD) {
    console.log("LEDGER_PASSWORD is not set. API is open to anyone who can reach this server.");
  }
});

async function handleApi(request, response, url) {
  if (url.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, {
      ok: true,
      authRequired: Boolean(PASSWORD),
      storage: hasSupabase() ? "supabase" : "file",
    });
    return;
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (isEntriesPath(url.pathname) && request.method === "GET") {
    sendJson(response, 200, await readLedger());
    return;
  }

  if (isEntriesPath(url.pathname) && request.method === "POST") {
    const payload = await readJsonBody(request);
    const entry = normalizeEntry(payload.entry || payload);
    if (!entry) {
      sendJson(response, 400, { error: "invalid_entry" });
      return;
    }

    sendJson(response, 201, await addEntry(entry));
    return;
  }

  if (isEntriesPath(url.pathname) && request.method === "PUT") {
    const payload = await readJsonBody(request);
    const imported = Array.isArray(payload) ? payload : payload.entries;
    if (!Array.isArray(imported)) {
      sendJson(response, 400, { error: "invalid_entries" });
      return;
    }

    const entries = imported.map(normalizeEntry).filter(Boolean);
    const ledger = { entries, updatedAt: new Date().toISOString() };
    await writeLedger(ledger);
    sendJson(response, 200, ledger);
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/entries\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    const id = decodeURIComponent(deleteMatch[1]);
    sendJson(response, 200, await deleteEntry(id));
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function isAuthorized(request) {
  if (!PASSWORD) return true;
  return request.headers["x-ledger-password"] === PASSWORD;
}

function isEntriesPath(pathname) {
  return pathname === "/api/entries" || pathname === "/api/entries/";
}

async function readLedger() {
  if (hasSupabase()) {
    const rows = await supabaseRequest(
      `/${SUPABASE_TABLE}?select=*&order=created_at.desc`,
      { method: "GET" }
    );
    return {
      entries: rows.map(rowToEntry).filter(Boolean),
      updatedAt: rows[0]?.created_at || null,
    };
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    return {
      entries: Array.isArray(data.entries) ? data.entries.map(normalizeEntry).filter(Boolean) : [],
      updatedAt: data.updatedAt || null,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const ledger = { entries: [], updatedAt: new Date().toISOString() };
    await writeLedger(ledger);
    return ledger;
  }
}

async function writeLedger(ledger) {
  if (hasSupabase()) {
    const entries = Array.isArray(ledger.entries) ? ledger.entries.map(normalizeEntry).filter(Boolean) : [];
    await supabaseRequest(`/${SUPABASE_TABLE}?id=neq.00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
    });
    if (entries.length) {
      await supabaseRequest(`/${SUPABASE_TABLE}`, {
        method: "POST",
        body: JSON.stringify(entries.map(entryToRow)),
        headers: { Prefer: "return=minimal" },
      });
    }
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const nextLedger = {
    entries: Array.isArray(ledger.entries) ? ledger.entries : [],
    updatedAt: new Date().toISOString(),
  };
  const tempFile = `${DATA_FILE}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(nextLedger, null, 2)}\n`);
  await fs.rename(tempFile, DATA_FILE);
}

async function addEntry(entry) {
  if (!hasSupabase()) {
    const ledger = await readLedger();
    ledger.entries.push(entry);
    await writeLedger(ledger);
    return { entry, entries: ledger.entries };
  }

  const rows = await supabaseRequest(`/${SUPABASE_TABLE}`, {
    method: "POST",
    body: JSON.stringify(entryToRow(entry)),
    headers: { Prefer: "return=representation" },
  });
  return { entry: rowToEntry(rows[0]) || entry, entries: (await readLedger()).entries };
}

async function deleteEntry(id) {
  if (!hasSupabase()) {
    const ledger = await readLedger();
    const before = ledger.entries.length;
    ledger.entries = ledger.entries.filter((entry) => entry.id !== id);
    ledger.updatedAt = new Date().toISOString();
    await writeLedger(ledger);
    return { deleted: before !== ledger.entries.length, entries: ledger.entries };
  }

  const rows = await supabaseRequest(`/${SUPABASE_TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  return { deleted: rows.length > 0, entries: (await readLedger()).entries };
}

function hasSupabase() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

async function supabaseRequest(pathname, options = {}) {
  const authHeaders = {
    apikey: SUPABASE_SECRET_KEY,
  };
  if (isJwtKey(SUPABASE_SECRET_KEY)) {
    authHeaders.Authorization = `Bearer ${SUPABASE_SECRET_KEY}`;
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    ...options,
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`supabase_error: ${errorText || response.status}`);
    error.statusCode = response.status >= 400 && response.status < 500 ? 400 : 500;
    throw error;
  }

  if (response.status === 204) return [];
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

function isJwtKey(key) {
  return key.split(".").length === 3;
}

function rowToEntry(row) {
  if (!row) return null;
  return normalizeEntry({
    id: row.id,
    date: row.entry_date,
    type: row.entry_type,
    amount: row.amount,
    category: row.category,
    note: row.note,
    image: row.image,
    createdAt: row.created_at,
  });
}

function entryToRow(entry) {
  return {
    id: entry.id,
    entry_date: entry.date,
    entry_type: entry.type,
    amount: entry.amount,
    category: entry.category,
    note: entry.note,
    image: entry.image,
    created_at: entry.createdAt,
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const amount = Math.round(Number(entry.amount) * 100) / 100;
  if (!entry.date || !["income", "expense"].includes(entry.type) || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const image = normalizeImage(entry.image);
  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : crypto.randomUUID(),
    date: String(entry.date).slice(0, 10),
    type: entry.type,
    amount,
    category: typeof entry.category === "string" && entry.category ? entry.category : "未分类",
    note: typeof entry.note === "string" ? entry.note : "",
    image,
    createdAt: typeof entry.createdAt === "string" && entry.createdAt ? entry.createdAt : new Date().toISOString(),
  };
}

function normalizeImage(image) {
  if (!image || typeof image !== "object" || typeof image.dataUrl !== "string") return null;
  if (!image.dataUrl.startsWith("data:image/")) return null;

  return {
    name: typeof image.name === "string" ? image.name : "记录图片",
    type: typeof image.type === "string" ? image.type : "image/*",
    size: Number.isFinite(Number(image.size)) ? Number(image.size) : 0,
    dataUrl: image.dataUrl,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(url, response) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT_DIR, safePath);
  const relative = path.relative(ROOT_DIR, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.startsWith("data")) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "content-type": mimeTypes[extension] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    throw error;
  }
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}
