const CF_API = "https://api.cloudflare.com/client/v4";

export type CfError = { code?: number; message: string };
export type CfEnvelope<T> = {
  success: boolean;
  errors: CfError[];
  result: T;
  result_info?: { page: number; per_page: number; count: number; total_count: number };
};

export type CfAccount = { id: string; name: string };
export type D1DatabaseInfo = {
  uuid: string;
  name: string;
  version?: string;
  created_at?: string;
  file_size?: number;
  num_tables?: number;
};

export type D1QueryMeta = {
  duration?: number;
  rows_read?: number;
  rows_written?: number;
  changes?: number;
  last_row_id?: number;
  changed_db?: boolean;
};

export type D1QueryResult = {
  results: Record<string, unknown>[];
  success: boolean;
  meta?: D1QueryMeta;
};

export class CfApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function cfFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = (await res.json()) as CfEnvelope<T>;
  if (!res.ok || !body.success) {
    const message = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || `Cloudflare API ${res.status}`;
    throw new CfApiError(res.status, message);
  }
  return body.result;
}

export async function listAccounts(token: string): Promise<CfAccount[]> {
  const result = await cfFetch<CfAccount[]>(token, "/accounts?per_page=50");
  return result ?? [];
}

export async function listDatabases(token: string, accountId: string): Promise<D1DatabaseInfo[]> {
  const all: D1DatabaseInfo[] = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `${CF_API}/accounts/${accountId}/d1/database?page=${page}&per_page=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await res.json()) as CfEnvelope<D1DatabaseInfo[]>;
    if (!res.ok || !body.success) {
      const message = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || `Cloudflare API ${res.status}`;
      throw new CfApiError(res.status, message);
    }
    all.push(...(body.result ?? []));
    const info = body.result_info;
    if (!info || page * info.per_page >= info.total_count) break;
    page += 1;
    if (page > 20) break;
  }
  return all;
}

export async function getDatabase(
  token: string,
  accountId: string,
  databaseId: string,
): Promise<D1DatabaseInfo> {
  return cfFetch<D1DatabaseInfo>(token, `/accounts/${accountId}/d1/database/${databaseId}`);
}

export async function queryD1(
  token: string,
  accountId: string,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<D1QueryResult> {
  const result = await cfFetch<D1QueryResult[]>(
    token,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    },
  );
  const first = result?.[0];
  if (!first) return { results: [], success: true };
  return first;
}

export type KvNamespaceInfo = {
  id: string;
  title: string;
  supports_url_encoding?: boolean;
};

export type KvKeyInfo = {
  name: string;
  expiration?: number;
  metadata?: unknown;
};

export type KvKeysPage = {
  keys: KvKeyInfo[];
  cursor: string | null;
  count: number;
};

export type WorkerScriptInfo = {
  id: string;
  created_on?: string;
  modified_on?: string;
  etag?: string;
  handlers?: string[];
  usage_model?: string;
  last_deployed_from?: string;
  deployment_id?: string;
  has_assets?: boolean;
  has_modules?: boolean;
};

export type WorkerBinding = {
  name: string;
  type: string;
  [key: string]: unknown;
};

export type WorkerSettings = {
  bindings?: WorkerBinding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  usage_model?: string;
  tags?: string[];
  logpush?: boolean;
  [key: string]: unknown;
};

async function cfFetchPaged<T>(
  token: string,
  path: string,
  pageKey: "page" = "page",
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${CF_API}${path}${sep}${pageKey}=${page}&per_page=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as CfEnvelope<T[]>;
    if (!res.ok || !body.success) {
      const message = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || `Cloudflare API ${res.status}`;
      throw new CfApiError(res.status, message);
    }
    all.push(...(body.result ?? []));
    const info = body.result_info;
    if (!info || page * (info.per_page || 50) >= (info.total_count ?? all.length)) break;
    page += 1;
    if (page > 40) break;
  }
  return all;
}

export async function listKvNamespaces(token: string, accountId: string): Promise<KvNamespaceInfo[]> {
  return cfFetchPaged<KvNamespaceInfo>(token, `/accounts/${accountId}/storage/kv/namespaces`);
}

export async function listKvKeys(
  token: string,
  accountId: string,
  namespaceId: string,
  opts: { prefix?: string; cursor?: string; limit?: number } = {},
): Promise<KvKeysPage> {
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(Math.max(opts.limit ?? 100, 10), 1000)));
  if (opts.prefix) params.set("prefix", opts.prefix);
  if (opts.cursor) params.set("cursor", opts.cursor);
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json()) as CfEnvelope<KvKeyInfo[]> & {
    result_info?: { count?: number; cursor?: string };
  };
  if (!res.ok || !body.success) {
    const message = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || `Cloudflare API ${res.status}`;
    throw new CfApiError(res.status, message);
  }
  return {
    keys: body.result ?? [],
    cursor: body.result_info?.cursor || null,
    count: body.result_info?.count ?? (body.result?.length ?? 0),
  };
}

export async function getKvValue(
  token: string,
  accountId: string,
  namespaceId: string,
  key: string,
): Promise<{ value: string; expiration: number | null; metadata: unknown }> {
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404) throw new CfApiError(404, "Key not found");
  if (!res.ok) {
    let message = `Cloudflare API ${res.status}`;
    try {
      const body = (await res.json()) as CfEnvelope<unknown>;
      message = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || message;
    } catch {
      /* raw body */
    }
    throw new CfApiError(res.status, message);
  }
  const expirationHeader = res.headers.get("expiration");
  const metadataHeader = res.headers.get("metadata");
  let metadata: unknown = null;
  if (metadataHeader) {
    try {
      metadata = JSON.parse(metadataHeader);
    } catch {
      metadata = metadataHeader;
    }
  }
  return {
    value: await res.text(),
    expiration: expirationHeader ? Number(expirationHeader) : null,
    metadata,
  };
}

export async function putKvValue(
  token: string,
  accountId: string,
  namespaceId: string,
  key: string,
  value: string,
  opts: { expiration_ttl?: number; metadata?: unknown } = {},
): Promise<void> {
  const params = new URLSearchParams();
  if (opts.expiration_ttl != null && opts.expiration_ttl > 0) {
    params.set("expiration_ttl", String(opts.expiration_ttl));
  }
  const qs = params.toString();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: BodyInit = value;
  if (opts.metadata !== undefined) {
    const form = new FormData();
    form.set("value", new Blob([value], { type: "text/plain" }));
    form.set("metadata", JSON.stringify(opts.metadata ?? {}));
    body = form;
  } else {
    headers["Content-Type"] = "text/plain; charset=utf-8";
  }
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}${qs ? `?${qs}` : ""}`,
    { method: "PUT", headers, body },
  );
  if (!res.ok) {
    let message = `Cloudflare API ${res.status}`;
    try {
      const envelope = (await res.json()) as CfEnvelope<unknown>;
      message = envelope.errors?.map((e) => e.message).filter(Boolean).join("; ") || message;
    } catch {
      /* ignore */
    }
    throw new CfApiError(res.status, message);
  }
}

export async function deleteKvValue(
  token: string,
  accountId: string,
  namespaceId: string,
  key: string,
): Promise<void> {
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok && res.status !== 404) {
    let message = `Cloudflare API ${res.status}`;
    try {
      const envelope = (await res.json()) as CfEnvelope<unknown>;
      message = envelope.errors?.map((e) => e.message).filter(Boolean).join("; ") || message;
    } catch {
      /* ignore */
    }
    throw new CfApiError(res.status, message);
  }
}

export async function listWorkers(token: string, accountId: string): Promise<WorkerScriptInfo[]> {
  return cfFetch<WorkerScriptInfo[]>(token, `/accounts/${accountId}/workers/scripts`);
}

export async function getWorkerSettings(
  token: string,
  accountId: string,
  scriptName: string,
): Promise<WorkerSettings> {
  return cfFetch<WorkerSettings>(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
  );
}
