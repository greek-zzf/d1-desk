import { clearCookie, json, makeCookie, originOk, readSession, type Session } from "./auth";
import {
  CfApiError,
  deleteKvValue,
  getDatabase,
  getKvValue,
  getWorkerSettings,
  listAccounts,
  listDatabases,
  listKvKeys,
  listKvNamespaces,
  listWorkers,
  putKvValue,
  queryD1,
} from "./cf";
import { handleMailApi } from "./mail/api";
import { handleMigrate } from "./mail/migrate";
import { receiveEmail } from "./mail/receive";
import { likePattern, quoteIdent, type ColumnInfo } from "./sql";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/mail/migrate") {
        return await handleMigrate(request, env);
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url, ctx);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof JsonError) return json({ error: error.message }, { status: 400 });
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(JSON.stringify({ message: "unhandled error", error: message }));
      return json({ error: "Internal server error" }, { status: 500 });
    }
  },
  async email(message, env, ctx) {
    try {
      await receiveEmail(message, env, ctx);
    } catch (error) {
      const err = error instanceof Error ? error.message : "Unknown error";
      console.error(JSON.stringify({ message: "email handler failed", error: err }));
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (!env.AUTH_SECRET) {
    return json({ error: "AUTH_SECRET is not configured" }, { status: 500 });
  }
  if (!originOk(request)) {
    return json({ error: "Bad origin" }, { status: 403 });
  }

  const path = url.pathname;
  const method = request.method;

  if (method === "POST" && path === "/api/login") return login(request, env);
  if (method === "POST" && path === "/api/logout") {
    return json({ ok: true }, { headers: { "Set-Cookie": clearCookie(url.protocol === "https:") } });
  }

  const session = await readSession(request, env.AUTH_SECRET);
  if (!session) return json({ error: "Unauthorized" }, { status: 401 });

  if (method === "GET" && path === "/api/session") {
    return json({
      accountId: session.accountId,
      accountName: session.accountName,
      exp: session.exp,
    });
  }

  try {
    if (path.startsWith("/api/mail")) {
      return await handleMailApi(request, env, url, ctx);
    }

    if (path.startsWith("/api/kv")) {
      return await handleKvApi(request, session, url);
    }

    if (path.startsWith("/api/workers")) {
      return await handleWorkersApi(request, session, url);
    }

    if (method === "GET" && path === "/api/databases") {
      const databases = await listDatabases(session.token, session.accountId);
      databases.sort((a, b) => a.name.localeCompare(b.name));
      return json({ databases });
    }

    const dbMatch = path.match(/^\/api\/databases\/([^/]+)(?:\/(.*))?$/);
    if (!dbMatch) return json({ error: "Not found" }, { status: 404 });
    const databaseId = decodeURIComponent(dbMatch[1]);
    const rest = dbMatch[2] ?? "";

    if (method === "GET" && rest === "") {
      const info = await getDatabase(session.token, session.accountId, databaseId);
      return json({ database: info });
    }

    if (method === "GET" && rest === "tables") {
      return tables(session, databaseId);
    }

    const tableRows = rest.match(/^tables\/([^/]+)\/rows$/);
    if (tableRows) {
      const table = decodeURIComponent(tableRows[1]);
      if (method === "GET") return tableRowsGet(session, databaseId, table, url);
      if (method === "POST") return tableInsert(session, databaseId, table, request);
      if (method === "PATCH") return tableUpdate(session, databaseId, table, request);
      if (method === "DELETE") return tableDelete(session, databaseId, table, request);
    }

    const tableSchema = rest.match(/^tables\/([^/]+)\/schema$/);
    if (tableSchema && method === "GET") {
      return tableSchemaGet(session, databaseId, decodeURIComponent(tableSchema[1]));
    }

    if (method === "POST" && rest === "query") {
      const body = await readJson<{ sql?: string; params?: unknown[] }>(request);
      const sql = body.sql?.trim();
      if (!sql) return json({ error: "sql is required" }, { status: 400 });
      const result = await queryD1(session.token, session.accountId, databaseId, sql, body.params ?? []);
      return json({ result });
    }

    return json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof CfApiError) {
      return json({ error: error.message }, { status: error.status >= 400 ? error.status : 502 });
    }
    throw error;
  }
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new JsonError();
  }
}

class JsonError extends Error {
  constructor() {
    super("Invalid JSON body");
  }
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: string; accountId?: string }>(request);
  const token = body.token?.trim();
  if (!token) return json({ error: "API token is required" }, { status: 400 });

  let accounts;
  try {
    accounts = await listAccounts(token);
  } catch (error) {
    const message = error instanceof CfApiError ? error.message : "Token verification failed";
    return json({ error: message }, { status: 401 });
  }
  if (accounts.length === 0) return json({ error: "This token has no account access" }, { status: 403 });

  const chosen = body.accountId
    ? accounts.find((a) => a.id === body.accountId)
    : accounts.length === 1
      ? accounts[0]
      : null;

  if (!chosen) {
    return json({ accounts, needAccount: true });
  }

  const cookie = await makeCookie(
    { token, accountId: chosen.id, accountName: chosen.name },
    env.AUTH_SECRET,
    new URL(request.url).protocol === "https:",
  );
  return json(
    { ok: true, accountId: chosen.id, accountName: chosen.name },
    { headers: { "Set-Cookie": cookie } },
  );
}

async function tables(session: Session, databaseId: string): Promise<Response> {
  const result = await queryD1(
    session.token,
    session.accountId,
    databaseId,
    `SELECT name, type, sql
     FROM sqlite_master
     WHERE type IN ('table', 'view')
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '_cf_%'
     ORDER BY name`,
  );
  return json({
    tables: result.results.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      sql: row.sql == null ? null : String(row.sql),
    })),
  });
}

async function schemaOf(
  session: Session,
  databaseId: string,
  table: string,
): Promise<ColumnInfo[]> {
  const result = await queryD1(
    session.token,
    session.accountId,
    databaseId,
    `PRAGMA table_info(${quoteIdent(table)})`,
  );
  return result.results.map((row) => ({
    cid: Number(row.cid),
    name: String(row.name),
    type: String(row.type ?? ""),
    notnull: Number(row.notnull ?? 0),
    dflt_value: row.dflt_value,
    pk: Number(row.pk ?? 0),
  }));
}

async function tableSchemaGet(session: Session, databaseId: string, table: string): Promise<Response> {
  const columns = await schemaOf(session, databaseId, table);
  const master = await queryD1(
    session.token,
    session.accountId,
    databaseId,
    `SELECT sql, type FROM sqlite_master WHERE name = ? LIMIT 1`,
    [table],
  );
  return json({
    columns,
    sql: master.results[0]?.sql ?? null,
    type: master.results[0]?.type ?? "table",
  });
}

async function tableRowsGet(
  session: Session,
  databaseId: string,
  table: string,
  url: URL,
): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
  const orderBy = url.searchParams.get("orderBy");
  const dir = url.searchParams.get("dir") === "desc" ? "DESC" : "ASC";
  const q = url.searchParams.get("q")?.trim() ?? "";

  const columns = await schemaOf(session, databaseId, table);
  const orderSql =
    orderBy && columns.some((c) => c.name === orderBy)
      ? ` ORDER BY ${quoteIdent(orderBy)} ${dir}`
      : " ORDER BY rowid";

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (q) {
    const searchable = columns.filter((c) => !/BLOB/i.test(c.type));
    if (searchable.length > 0) {
      whereParts.push(
        `(${searchable.map((c) => `CAST(${quoteIdent(c.name)} AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
      );
      const pat = likePattern(q);
      for (const _ of searchable) params.push(pat);
    }
  }
  const whereSql = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";

  let usedRowid = true;
  let rows: Record<string, unknown>[];
  let total: number;
  try {
    const count = await queryD1(
      session.token,
      session.accountId,
      databaseId,
      `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${whereSql}`,
      params,
    );
    total = Number(count.results[0]?.n ?? 0);
    const data = await queryD1(
      session.token,
      session.accountId,
      databaseId,
      `SELECT rowid AS __rowid, * FROM ${quoteIdent(table)}${whereSql}${orderSql} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    rows = data.results;
  } catch {
    usedRowid = false;
    const count = await queryD1(
      session.token,
      session.accountId,
      databaseId,
      `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${whereSql}`,
      params,
    );
    total = Number(count.results[0]?.n ?? 0);
    const fallbackOrder =
      orderBy && columns.some((c) => c.name === orderBy)
        ? ` ORDER BY ${quoteIdent(orderBy)} ${dir}`
        : "";
    const data = await queryD1(
      session.token,
      session.accountId,
      databaseId,
      `SELECT * FROM ${quoteIdent(table)}${whereSql}${fallbackOrder} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    rows = data.results;
  }

  return json({ columns, rows, total, limit, offset, hasRowid: usedRowid });
}

async function tableInsert(
  session: Session,
  databaseId: string,
  table: string,
  request: Request,
): Promise<Response> {
  const body = await readJson<{ values?: Record<string, unknown> }>(request);
  const values = body.values ?? {};
  const columns = Object.keys(values);
  if (columns.length === 0) return json({ error: "values is required" }, { status: 400 });
  const sql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  const result = await queryD1(
    session.token,
    session.accountId,
    databaseId,
    sql,
    columns.map((c) => values[c]),
  );
  return json({ result });
}

async function tableUpdate(
  session: Session,
  databaseId: string,
  table: string,
  request: Request,
): Promise<Response> {
  const body = await readJson<{
    values?: Record<string, unknown>;
    where?: Record<string, unknown>;
  }>(request);
  const values = body.values ?? {};
  const where = body.where ?? {};
  const setCols = Object.keys(values);
  const whereCols = Object.keys(where);
  if (setCols.length === 0 || whereCols.length === 0) {
    return json({ error: "values and where are required" }, { status: 400 });
  }
  const sql = `UPDATE ${quoteIdent(table)} SET ${setCols.map((c) => `${quoteIdent(c)} = ?`).join(", ")} WHERE ${whereCols.map((c) => `${quoteIdent(c)} = ?`).join(" AND ")}`;
  const result = await queryD1(
    session.token,
    session.accountId,
    databaseId,
    sql,
    [...setCols.map((c) => values[c]), ...whereCols.map((c) => where[c])],
  );
  return json({ result });
}

async function tableDelete(
  session: Session,
  databaseId: string,
  table: string,
  request: Request,
): Promise<Response> {
  const body = await readJson<{ where?: Record<string, unknown> }>(request);
  const where = body.where ?? {};
  const whereCols = Object.keys(where);
  if (whereCols.length === 0) return json({ error: "where is required" }, { status: 400 });
  const sql = `DELETE FROM ${quoteIdent(table)} WHERE ${whereCols.map((c) => `${quoteIdent(c)} = ?`).join(" AND ")}`;
  const result = await queryD1(
    session.token,
    session.accountId,
    databaseId,
    sql,
    whereCols.map((c) => where[c]),
  );
  return json({ result });
}

async function handleKvApi(request: Request, session: Session, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/api/kv/namespaces") {
    const namespaces = await listKvNamespaces(session.token, session.accountId);
    namespaces.sort((a, b) => a.title.localeCompare(b.title));
    return json({ namespaces });
  }

  const nsMatch = path.match(/^\/api\/kv\/namespaces\/([^/]+)(?:\/(.*))?$/);
  if (!nsMatch) return json({ error: "Not found" }, { status: 404 });
  const namespaceId = decodeURIComponent(nsMatch[1]);
  const rest = nsMatch[2] ?? "";

  if (method === "GET" && rest === "keys") {
    const page = await listKvKeys(session.token, session.accountId, namespaceId, {
      prefix: url.searchParams.get("prefix") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
      limit: Number(url.searchParams.get("limit") || 100) || 100,
    });
    return json(page);
  }

  const valueMatch = rest.match(/^values\/(.+)$/);
  if (valueMatch) {
    const key = decodeURIComponent(valueMatch[1]);
    if (method === "GET") {
      const data = await getKvValue(session.token, session.accountId, namespaceId, key);
      return json({ key, ...data });
    }
    if (method === "PUT") {
      const body = await readJson<{ value?: string; expiration_ttl?: number; metadata?: unknown }>(request);
      if (typeof body.value !== "string") return json({ error: "value is required" }, { status: 400 });
      await putKvValue(session.token, session.accountId, namespaceId, key, body.value, {
        expiration_ttl: body.expiration_ttl,
        metadata: body.metadata,
      });
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await deleteKvValue(session.token, session.accountId, namespaceId, key);
      return json({ ok: true });
    }
  }

  return json({ error: "Not found" }, { status: 404 });
}

async function handleWorkersApi(request: Request, session: Session, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/api/workers") {
    const workers = await listWorkers(session.token, session.accountId);
    workers.sort((a, b) => a.id.localeCompare(b.id));
    return json({ workers });
  }

  const detail = path.match(/^\/api\/workers\/([^/]+)$/);
  if (detail && method === "GET") {
    const name = decodeURIComponent(detail[1]);
    let settings: Awaited<ReturnType<typeof getWorkerSettings>> | null = null;
    try {
      settings = await getWorkerSettings(session.token, session.accountId, name);
    } catch (error) {
      if (!(error instanceof CfApiError) || (error.status !== 404 && error.status !== 400)) throw error;
    }
    return json({ worker: { id: name }, settings });
  }

  return json({ error: "Not found" }, { status: 404 });
}
