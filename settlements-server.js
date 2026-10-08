const fs = require("node:fs/promises");
const path = require("node:path");

const TABLE = "/ledger_settlements";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeRecord(value) {
  if (!value || typeof value !== "object") throw new Error("invalid_record");
  const { id, date, kind } = value;
  const person = typeof value.person === "string" ? value.person.trim().normalize("NFC") : "";
  const note = typeof value.note === "string" ? value.note.trim() : "";
  const amount = Number(value.amount);
  const cents = Math.round(amount * 100);
  if (!uuid.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
      !["advance", "reimbursement"].includes(kind) || !person || person.length > 60 ||
      note.length > 1000 || !Number.isSafeInteger(cents) || cents <= 0 ||
      cents > 999999999999 || Math.abs(amount * 100 - cents) > 0.0001) {
    throw new Error("invalid_record");
  }
  return { id, date, person, kind, amount: cents / 100, note, createdAt: new Date().toISOString() };
}

function fromRow(row) {
  return { id: row.id, date: row.entry_date, person: row.person, kind: row.kind,
    amount: Number(row.amount), note: row.note, createdAt: row.created_at };
}

function createSettlementHandler({ dataDir, hasSupabase, supabaseRequest, readJsonBody, sendJson }) {
  const file = path.join(dataDir, "settlements.json");
  let pendingWrite = Promise.resolve();

  async function readLocal() {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  function changeLocal(change) {
    const next = pendingWrite.then(async () => {
      const records = await readLocal();
      const result = change(records);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(records));
      await fs.rename(`${file}.tmp`, file);
      return result;
    });
    pendingWrite = next.catch(() => {});
    return next;
  }

  return async function handle(request, response, url) {
    if (url.pathname !== "/api/settlements" && !url.pathname.startsWith("/api/settlements/")) return false;
    try {
      if (url.pathname === "/api/settlements" && request.method === "GET") {
        let records;
        if (hasSupabase()) {
          records = [];
          // Explicit paging also works when the project caps API responses at 1000 rows.
          for (let offset = 0; ; offset += 500) {
            const rows = await supabaseRequest(`${TABLE}?select=*&order=entry_date.desc,created_at.desc,id.asc&limit=500&offset=${offset}`, { method: "GET" });
            records.push(...rows.map(fromRow));
            if (rows.length < 500) break;
          }
        } else { await pendingWrite; records = await readLocal(); }
        sendJson(response, 200, { records });
      } else if (url.pathname === "/api/settlements" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const record = normalizeRecord(payload.record);
        let saved = record;
        if (hasSupabase()) {
          const { id, date, person, kind, amount, note, createdAt } = record;
          const rows = await supabaseRequest(`${TABLE}?on_conflict=id`, {
            method: "POST",
            headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
            body: JSON.stringify({ id, entry_date: date, person, kind, amount, note, created_at: createdAt }),
          });
          if (rows.length) saved = fromRow(rows[0]);
          else {
            const existing = await supabaseRequest(`${TABLE}?id=eq.${id}&select=*`, { method: "GET" });
            saved = fromRow(existing[0]);
          }
        } else {
          saved = await changeLocal(records => {
            const existing = records.find(item => item.id === record.id);
            if (existing) return existing;
            records.push(record);
            return record;
          });
        }
        sendJson(response, 201, { record: saved });
      } else if (request.method === "DELETE" && uuid.test(url.pathname.slice("/api/settlements/".length))) {
        const id = url.pathname.slice("/api/settlements/".length);
        if (hasSupabase()) await supabaseRequest(`${TABLE}?id=eq.${id}`, { method: "DELETE" });
        else await changeLocal(records => {
          const index = records.findIndex(item => item.id === id);
          if (index !== -1) records.splice(index, 1);
        });
        sendJson(response, 200, { id, deleted: true });
      } else sendJson(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      const missingTable = /PGRST205|42P01/.test(error.message);
      const invalid = error.message === "invalid_record" || error instanceof SyntaxError;
      sendJson(response, missingTable ? 503 : invalid ? 400 : 500, {
        error: missingTable ? "settlements_not_initialized" : invalid ? "invalid_record" : "settlements_unavailable",
      });
    }
    return true;
  };
}

module.exports = { createSettlementHandler, normalizeRecord };
