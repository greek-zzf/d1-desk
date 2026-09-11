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
