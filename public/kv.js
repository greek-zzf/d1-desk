import { api, formatTime, go, h, toast, withBusy } from "./app.js";

export const kv = {
  namespaces: [],
  filter: "",
  nsId: "",
  keys: [],
  cursor: null,
  prefix: "",
  selectedKey: "",
  value: "",
  expiration: null,
  metadata: null,
  dirty: false,
  putOpen: false,
  putKey: "",
  putValue: "",
  putTtl: "",
};

export function resetKv() {
  Object.assign(kv, {
    namespaces: [],
    filter: "",
    nsId: "",
    keys: [],
    cursor: null,
    prefix: "",
    selectedKey: "",
    value: "",
    expiration: null,
    metadata: null,
    dirty: false,
    putOpen: false,
    putKey: "",
    putValue: "",
    putTtl: "",
  });
}

export function parseKvHash(raw) {
  const parts = raw.split("/").filter(Boolean);
  return {
    page: "kv",
    nsId: parts[1] ? decodeURIComponent(parts[1]) : "",
    key: parts[2] ? decodeURIComponent(parts[2]) : "",
  };
}

function rerender() {
  window.dispatchEvent(new Event("kv-render"));
}

export async function loadKvRoute(loc) {
  if (kv.namespaces.length === 0) {
    const data = await api("/api/kv/namespaces");
    kv.namespaces = data.namespaces || [];
  }
  kv.nsId = loc.nsId || "";
  if (!kv.nsId) {
    kv.keys = [];
    kv.cursor = null;
    kv.selectedKey = "";
    kv.value = "";
    return;
  }
  await loadKeys(true);
  if (loc.key) await openKey(loc.key, false);
  else {
    kv.selectedKey = "";
    kv.value = "";
    kv.expiration = null;
    kv.metadata = null;
    kv.dirty = false;
  }
}

async function loadKeys(reset = false) {
  if (!kv.nsId) return;
  if (reset) {
    kv.keys = [];
    kv.cursor = null;
  }
  const params = new URLSearchParams({ limit: "100" });
  if (kv.prefix.trim()) params.set("prefix", kv.prefix.trim());
  if (!reset && kv.cursor) params.set("cursor", kv.cursor);
  const data = await api(`/api/kv/namespaces/${encodeURIComponent(kv.nsId)}/keys?${params}`);
  const next = data.keys || [];
  kv.keys = reset ? next : [...kv.keys, ...next];
  kv.cursor = data.cursor || null;
}

async function openKey(name, pushHash = true) {
  const data = await api(
    `/api/kv/namespaces/${encodeURIComponent(kv.nsId)}/values/${encodeURIComponent(name)}`,
  );
  kv.selectedKey = name;
  kv.value = data.value ?? "";
  kv.expiration = data.expiration ?? null;
  kv.metadata = data.metadata ?? null;
  kv.dirty = false;
  if (pushHash) go(`/kv/${encodeURIComponent(kv.nsId)}/${encodeURIComponent(name)}`);
}

export function kvView() {
  if (!kv.nsId) return namespacesView();
  return workspaceView();
}

function namespacesView() {
  const q = kv.filter.trim().toLowerCase();
  const list = kv.namespaces.filter(
    (n) => !q || n.title.toLowerCase().includes(q) || n.id.includes(q),
  );
  return h("div", { class: "home" },
    h("div", { class: "home-head" },
      h("div", {},
        h("div", { class: "kicker" }, "WORKERS KV"),
        h("h2", {}, `${kv.namespaces.length} 个 Namespace`),
      ),
      h("input", {
        class: "search",
        placeholder: "搜索标题或 ID",
        value: kv.filter,
        onInput: (e) => { kv.filter = e.target.value; rerender(); },
      }),
    ),
    list.length === 0
      ? h("div", { class: "empty" },
          h("h3", {}, "没有匹配的 Namespace"),
          h("p", {}, "确认 Token 有 Workers KV Storage 权限，并且账号下已创建 KV。"),
        )
      : h("div", { class: "grid" },
          ...list.map((n) =>
            h("a", { class: "card", href: `#/kv/${encodeURIComponent(n.id)}` },
              h("div", { class: "kicker" }, "KV"),
              h("h3", {}, n.title),
              h("div", { class: "uuid" }, n.id),
              h("div", { class: "meta" },
                h("span", {}, n.supports_url_encoding ? "URL decode on" : "URL decode off"),
              ),
            ),
          ),
        ),
  );
}

function workspaceView() {
  const ns = kv.namespaces.find((n) => n.id === kv.nsId);
  return h("div", { class: "work" },
    h("aside", { class: "side" },
      h("div", { class: "side-head" },
        h("div", { class: "kicker" }, "NAMESPACE"),
        h("h2", {}, ns?.title || kv.nsId),
      ),
      h("div", { class: "side-tools" },
        h("input", {
          class: "search",
          style: "max-width:none",
          placeholder: "按前缀筛选 key",
          value: kv.prefix,
          onInput: (e) => { kv.prefix = e.target.value; },
          onKeydown: (e) => {
            if (e.key === "Enter") withBusy(() => loadKeys(true)).then(rerender);
          },
        }),
        h("button", {
          class: "btn",
          style: "width:100%;margin-top:8px;justify-content:center",
          onClick: () => withBusy(() => loadKeys(true)).then(rerender),
        }, "筛选"),
      ),
      h("div", { class: "table-list" },
        ...kv.keys.map((k) =>
          h("button", {
            class: `table-item ${kv.selectedKey === k.name ? "active" : ""}`,
            onClick: () => withBusy(() => openKey(k.name)).then(rerender),
          },
            h("span", { class: "name" }, k.name),
            h("span", { class: "kind" }, k.expiration ? "TTL" : "key"),
          ),
        ),
        kv.cursor
          ? h("button", {
              class: "btn",
              style: "width:100%;margin-top:8px;justify-content:center",
              onClick: () => withBusy(() => loadKeys(false)).then(rerender),
            }, "加载更多")
          : null,
        kv.keys.length === 0
          ? h("div", { class: "side-empty" }, "没有 key，或前缀无匹配")
          : null,
      ),
    ),
    h("section", { class: "main" },
      h("div", { class: "main-bar" },
        h("a", { class: "btn btn-ghost", href: "#/kv" }, "← Namespace"),
        h("h2", {}, kv.selectedKey || "选择一个 key"),
        h("div", { class: "spacer" }),
        h("button", {
          class: "btn",
          onClick: () => {
            kv.putOpen = true;
            kv.putKey = "";
            kv.putValue = "";
            kv.putTtl = "";
            rerender();
          },
        }, "新建 key"),
        kv.selectedKey
          ? h("button", {
              class: `btn ${kv.dirty ? "btn-primary" : ""}`,
              onClick: () => withBusy(saveValue).then(rerender),
            }, kv.dirty ? "保存*" : "保存")
          : null,
        kv.selectedKey
          ? h("button", {
              class: "btn btn-danger",
              onClick: () => withBusy(deleteValue).then(rerender),
            }, "删除")
          : null,
      ),
      h("div", { class: "pane" },
        kv.selectedKey ? valuePane() : h("div", { class: "empty" },
          h("h3", {}, "浏览 KV"),
          h("p", {}, "从左侧选择 key，或新建一个。"),
        ),
      ),
    ),
    kv.putOpen ? putModal() : null,
  );
}

function valuePane() {
  return h("div", { class: "kv-value" },
    h("div", { class: "meta", style: "margin-bottom:12px" },
      kv.expiration
        ? h("span", {}, `过期 ${formatTime(new Date(kv.expiration * 1000).toISOString())}`)
        : h("span", {}, "不过期"),
      kv.metadata != null
        ? h("span", {}, `metadata ${typeof kv.metadata === "string" ? kv.metadata : JSON.stringify(kv.metadata)}`)
        : null,
    ),
    h("textarea", {
      class: "sql-editor kv-editor",
      value: kv.value,
      onInput: (e) => {
        kv.value = e.target.value;
        kv.dirty = true;
      },
    }),
  );
}

function putModal() {
  return h("div", {
    class: "modal-back",
    onClick: (e) => {
      if (e.target === e.currentTarget) {
        kv.putOpen = false;
        rerender();
      }
    },
  },
    h("div", { class: "modal" },
      h("h3", {}, "新建 / 覆盖 key"),
      h("div", { class: "field" },
        h("label", {}, "Key"),
        h("input", {
          value: kv.putKey,
          onInput: (e) => { kv.putKey = e.target.value; },
        }),
      ),
      h("div", { class: "field" },
        h("label", {}, "Value"),
        h("textarea", {
          class: "sql-editor",
          style: "min-height:160px",
          value: kv.putValue,
          onInput: (e) => { kv.putValue = e.target.value; },
        }),
      ),
      h("div", { class: "field" },
        h("label", {}, "TTL（秒，可选）"),
        h("input", {
          type: "number",
          min: "60",
          placeholder: "留空则不过期",
          value: kv.putTtl,
          onInput: (e) => { kv.putTtl = e.target.value; },
        }),
      ),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onClick: () => { kv.putOpen = false; rerender(); } }, "取消"),
        h("button", {
          class: "btn btn-primary",
          onClick: () => withBusy(createKey).then(rerender),
        }, "写入"),
      ),
    ),
  );
}

async function saveValue() {
  if (!kv.selectedKey) return;
  await api(
    `/api/kv/namespaces/${encodeURIComponent(kv.nsId)}/values/${encodeURIComponent(kv.selectedKey)}`,
    { method: "PUT", body: { value: kv.value } },
  );
  kv.dirty = false;
  toast("已保存");
}

async function deleteValue() {
  if (!kv.selectedKey) return;
  if (!confirm(`删除 key「${kv.selectedKey}」？`)) return;
  const name = kv.selectedKey;
  await api(
    `/api/kv/namespaces/${encodeURIComponent(kv.nsId)}/values/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  kv.keys = kv.keys.filter((k) => k.name !== name);
  kv.selectedKey = "";
  kv.value = "";
  kv.dirty = false;
  go(`/kv/${encodeURIComponent(kv.nsId)}`);
  toast("已删除");
}

async function createKey() {
  const key = kv.putKey.trim();
  if (!key) throw new Error("key 不能为空");
  const ttl = kv.putTtl.trim() ? Number(kv.putTtl) : undefined;
  await api(
    `/api/kv/namespaces/${encodeURIComponent(kv.nsId)}/values/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      body: {
        value: kv.putValue,
        ...(ttl && ttl > 0 ? { expiration_ttl: ttl } : {}),
      },
    },
  );
  kv.putOpen = false;
  await loadKeys(true);
  await openKey(key);
  toast("已写入");
}
