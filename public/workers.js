import { api, formatTime, h } from "./app.js";

export const workers = {
  list: [],
  filter: "",
  name: "",
  detail: null,
  settings: null,
};

export function resetWorkers() {
  Object.assign(workers, {
    list: [],
    filter: "",
    name: "",
    detail: null,
    settings: null,
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
    return;
  }
  const data = await api(`/api/workers/${encodeURIComponent(workers.name)}`);
  const cached = workers.list.find((w) => w.id === workers.name);
  workers.detail = { ...(cached || {}), ...(data.worker || { id: workers.name }) };
  workers.settings = data.settings || null;
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
