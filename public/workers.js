import { api, formatTime, h } from "./app.js";

const SINCE_OPTIONS = [
  { id: "15m", label: "15 分钟" },
  { id: "1h", label: "1 小时" },
  { id: "6h", label: "6 小时" },
  { id: "24h", label: "24 小时" },
  { id: "7d", label: "7 天" },
];

export const workers = {
  list: [],
  filter: "",
  name: "",
  detail: null,
  settings: null,
  logs: [],
  logsCount: 0,
  logsSince: "1h",
  logsKind: "all",
  logsQ: "",
  logsError: "",
  logsCursor: null,
  logsHasMore: false,
  logsBusy: false,
  expandedLog: "",
};

export function resetWorkers() {
  Object.assign(workers, {
    list: [],
    filter: "",
    name: "",
    detail: null,
    settings: null,
    logs: [],
    logsCount: 0,
    logsSince: "1h",
    logsKind: "all",
    logsQ: "",
    logsError: "",
    logsCursor: null,
    logsHasMore: false,
    logsBusy: false,
    expandedLog: "",
  });
}

export function parseWorkersHash(raw) {
  const parts = raw.split("/").filter(Boolean);
  return {
    page: "workers",
    name: parts[1] ? decodeURIComponent(parts[1]) : "",
  };
}

function rerender() {
  window.dispatchEvent(new Event("workers-render"));
}

export async function loadWorkersRoute(loc) {
  if (workers.list.length === 0) {
    const data = await api("/api/workers");
    workers.list = data.workers || [];
  }
  workers.name = loc.name || "";
  if (!workers.name) {
    workers.detail = null;
    workers.settings = null;
    workers.logs = [];
    workers.logsError = "";
    workers.logsCursor = null;
    workers.logsHasMore = false;
    workers.expandedLog = "";
    return;
  }
  const data = await api(`/api/workers/${encodeURIComponent(workers.name)}`);
  const cached = workers.list.find((w) => w.id === workers.name);
  workers.detail = { ...(cached || {}), ...(data.worker || { id: workers.name }) };
  workers.settings = data.settings || null;
  await loadWorkerLogs();
}

async function loadWorkerLogs({ append = false } = {}) {
  if (!workers.name) return;
  workers.logsBusy = true;
  if (!append) {
    workers.logsError = "";
    workers.expandedLog = "";
  }
  rerender();
  try {
    const params = new URLSearchParams();
    params.set("since", workers.logsSince || "1h");
    params.set("kind", workers.logsKind || "all");
    params.set("limit", "100");
    if (workers.logsQ.trim()) params.set("q", workers.logsQ.trim());
    if (append && workers.logsCursor) params.set("offset", workers.logsCursor);
    const data = await api(`/api/workers/${encodeURIComponent(workers.name)}/logs?${params}`);
    const next = data.events || [];
    workers.logs = append ? workers.logs.concat(next) : next;
    workers.logsCount = data.count ?? workers.logs.length;
    workers.logsCursor = data.cursor || null;
    workers.logsHasMore = !!data.hasMore;
    workers.logsError = "";
  } catch (err) {
    if (!append) {
      workers.logs = [];
      workers.logsCount = 0;
      workers.logsCursor = null;
      workers.logsHasMore = false;
    }
    workers.logsError = err.message || "加载日志失败";
  } finally {
    workers.logsBusy = false;
    rerender();
  }
}

export function workersView() {
  if (workers.name) return detailView();
  return listView();
}

function listView() {
  const q = workers.filter.trim().toLowerCase();
  const list = workers.list.filter(
    (w) => !q || w.id.toLowerCase().includes(q),
  );
  return h("div", { class: "home" },
    h("div", { class: "home-head" },
      h("div", {},
        h("div", { class: "kicker" }, "CLOUDFLARE WORKERS"),
        h("h2", {}, `${workers.list.length} 个 Worker`),
      ),
      h("input", {
        class: "search",
        placeholder: "搜索脚本名",
        value: workers.filter,
        onInput: (e) => { workers.filter = e.target.value; rerender(); },
      }),
    ),
    list.length === 0
      ? h("div", { class: "empty" },
          h("h3", {}, "没有匹配的 Worker"),
          h("p", {}, "确认 Token 有 Workers Scripts Read 权限。"),
        )
      : h("div", { class: "grid" },
          ...list.map((w) =>
            h("a", { class: "card", href: `#/workers/${encodeURIComponent(w.id)}` },
              h("div", { class: "kicker" }, w.usage_model || "WORKER"),
              h("h3", {}, w.id),
              h("div", { class: "meta" },
                h("span", {}, w.handlers?.length ? w.handlers.join(", ") : "handlers —"),
                h("span", {}, w.has_modules ? "modules" : w.has_assets ? "assets" : "script"),
              ),
              h("div", { class: "meta" },
                h("span", {}, `更新 ${formatTime(w.modified_on)}`),
              ),
            ),
          ),
        ),
  );
}

function detailView() {
  const w = workers.detail || { id: workers.name };
  const settings = workers.settings || {};
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  return h("div", { class: "home worker-detail" },
    h("div", { class: "home-head" },
      h("div", {},
        h("div", { class: "kicker" }, "WORKER"),
        h("h2", {}, w.id),
      ),
      h("a", { class: "btn", href: "#/workers" }, "← 全部 Workers"),
    ),
    h("div", { class: "grid worker-meta-grid" },
      metaCard("创建", formatTime(w.created_on)),
      metaCard("更新", formatTime(w.modified_on)),
      metaCard("Handlers", (w.handlers || []).join(", ") || "—"),
      metaCard("Usage model", w.usage_model || settings.usage_model || "—"),
      metaCard("Compatibility", settings.compatibility_date || "—"),
      metaCard("Deploy from", w.last_deployed_from || "—"),
    ),
    settings.compatibility_flags?.length
      ? h("div", { class: "section-block" },
          h("div", { class: "kicker" }, "COMPATIBILITY FLAGS"),
          h("div", { class: "chip-row" },
            ...settings.compatibility_flags.map((f) => h("span", { class: "chip" }, f)),
          ),
        )
      : null,
    logsView(),
    h("div", { class: "section-block" },
      h("div", { class: "home-head", style: "margin-bottom:12px" },
        h("div", {},
          h("div", { class: "kicker" }, "BINDINGS"),
          h("h2", { style: "font-size:22px" }, `${bindings.length} 个绑定`),
        ),
      ),
      bindings.length === 0
        ? h("div", { class: "empty" }, h("h3", {}, "没有 bindings"), h("p", {}, "这个 Worker 可能没有配置绑定，或 Token 读不到 settings。"))
        : h("div", { class: "table-wrap" },
            h("table", { class: "data" },
              h("thead", {},
                h("tr", {},
                  h("th", {}, "Name"),
                  h("th", {}, "Type"),
                  h("th", {}, "Detail"),
                ),
              ),
              h("tbody", {},
                ...bindings.map((b) =>
                  h("tr", {},
                    h("td", {}, b.name || "—"),
                    h("td", {}, b.type || "—"),
                    h("td", { class: "mono" }, bindingDetail(b)),
                  ),
                ),
              ),
            ),
          ),
    ),
    h("div", { class: "section-block" },
      h("div", { class: "kicker" }, "RAW SETTINGS"),
      h("pre", { class: "json-pre" }, JSON.stringify(settings, null, 2)),
    ),
  );
}

function logsView() {
  const sinceLabel = SINCE_OPTIONS.find((o) => o.id === workers.logsSince)?.label || "1 小时";
  return h("div", { class: "section-block" },
    h("div", { class: "home-head log-head" },
      h("div", {},
        h("div", { class: "kicker" }, "LOGS"),
        h("h2", { style: "font-size:22px" }, workers.logsBusy && workers.logs.length === 0
          ? "加载中…"
          : `${workers.logs.length} 条日志`),
      ),
      h("div", { class: "log-toolbar" },
        h("div", { class: "tabs" },
          ...SINCE_OPTIONS.map((opt) =>
            h("button", {
              class: `tab ${workers.logsSince === opt.id ? "active" : ""}`,
              disabled: workers.logsBusy,
              onClick: () => {
                if (workers.logsSince === opt.id) return;
                workers.logsSince = opt.id;
                loadWorkerLogs();
              },
            }, opt.label),
          ),
        ),
        h("div", { class: "tabs" },
          h("button", {
            class: `tab ${workers.logsKind === "all" ? "active" : ""}`,
            disabled: workers.logsBusy,
            onClick: () => {
              if (workers.logsKind === "all") return;
              workers.logsKind = "all";
              loadWorkerLogs();
            },
          }, "全部"),
          h("button", {
            class: `tab ${workers.logsKind === "errors" ? "active" : ""}`,
            disabled: workers.logsBusy,
            onClick: () => {
              if (workers.logsKind === "errors") return;
              workers.logsKind = "errors";
              loadWorkerLogs();
            },
          }, "错误"),
        ),
        h("input", {
          class: "search log-search",
          placeholder: "搜索日志",
          value: workers.logsQ,
          onInput: (e) => { workers.logsQ = e.target.value; },
          onKeydown: (e) => {
            if (e.key === "Enter") loadWorkerLogs();
          },
        }),
        h("button", {
          class: "btn",
          disabled: workers.logsBusy,
          onClick: () => loadWorkerLogs(),
        }, workers.logsBusy ? "刷新中" : "刷新"),
      ),
    ),
    workers.logsError
      ? h("div", { class: "err" }, workers.logsError)
      : null,
    logBody(sinceLabel),
  );
}

function logBody(sinceLabel) {
  if (workers.logsError && workers.logs.length === 0) return null;
  if (workers.logsBusy && workers.logs.length === 0) {
    return h("div", { class: "empty log-empty" },
      h("h3", {}, "加载日志…"),
      h("p", {}, "正在查询 Workers Observability。"),
    );
  }
  if (workers.logs.length === 0) {
    return h("div", { class: "empty log-empty" },
      h("h3", {}, "没有日志"),
      h("p", {}, workers.logsKind === "errors"
        ? `最近 ${sinceLabel} 没有错误日志。`
        : `最近 ${sinceLabel} 没有日志。确认这个 Worker 已开启 observability、有流量，并且 Token 有 Workers Observability · Write 权限。`),
    );
  }
  return h("div", { class: "log-stream" },
    ...workers.logs.map((ev, i) => logRow(ev, i)),
    workers.logsHasMore
      ? h("button", {
          class: "btn log-more",
          disabled: workers.logsBusy,
          onClick: () => loadWorkerLogs({ append: true }),
        }, workers.logsBusy ? "加载中…" : "加载更多")
      : null,
  );
}

function logRow(ev, index) {
  const key = ev.id || String(index);
  const open = workers.expandedLog === key;
  const tone = logTone(ev);
  return h("div", { class: `log-item ${tone}${open ? " open" : ""}` },
    h("button", {
      class: "log-row",
      onClick: () => {
        workers.expandedLog = open ? "" : key;
        rerender();
      },
    },
      h("span", { class: "log-time" }, formatLogTime(ev.timestamp)),
      h("span", { class: `log-level ${tone}` }, (ev.level || ev.outcome || "log").toUpperCase()),
      h("span", { class: "log-meta" }, logMeta(ev)),
      h("span", { class: "log-msg" }, ev.message || ev.error || "—"),
    ),
    open
      ? h("pre", { class: "json-pre log-json" }, JSON.stringify(ev.raw, null, 2))
      : null,
  );
}

function logTone(ev) {
  const level = (ev.level || "").toLowerCase();
  const outcome = (ev.outcome || "").toLowerCase();
  if (level === "error" || outcome === "exception" || ev.error) return "error";
  if (level === "warn" || level === "warning") return "warn";
  if (typeof ev.status === "number" && ev.status >= 500) return "error";
  if (typeof ev.status === "number" && ev.status >= 400) return "warn";
  return "ok";
}

function logMeta(ev) {
  const parts = [];
  if (ev.eventType) parts.push(ev.eventType);
  if (ev.status != null) parts.push(String(ev.status));
  if (ev.outcome && ev.outcome !== "ok") parts.push(ev.outcome);
  if (ev.wallTimeMs != null) parts.push(`${Math.round(ev.wallTimeMs)}ms`);
  return parts.join(" · ") || "—";
}

function formatLogTime(ts) {
  if (!ts) return "—";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return formatTime(new Date(ms).toISOString());
}

function metaCard(label, value) {
  return h("div", { class: "card" },
    h("div", { class: "kicker" }, label),
    h("h3", {}, value),
  );
}

function bindingDetail(b) {
  const skip = new Set(["name", "type"]);
  const parts = Object.entries(b)
    .filter(([k, v]) => !skip.has(k) && v != null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  return parts.join(" · ") || "—";
}
