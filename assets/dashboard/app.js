"use strict";
const state = { csrf: "", page: "memories" };
const content = document.querySelector("#content");
const pageTitle = document.querySelector("#page-title");
const pageSubtitle = document.querySelector("#page-subtitle");
const status = document.querySelector("#status");
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function icon(name) {
  const node = element("i", undefined, `ph-thin ph-${name}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}
function actionButton(text, className, action, iconName) {
  const node = element("button", undefined, className);
  node.type = "button";
  if (iconName) node.append(icon(iconName));
  node.append(element("span", text));
  node.addEventListener("click", action);
  return node;
}
function iconButton(iconName, label, action, className = "") {
  const node = element("button", undefined, `icon-button ${className}`.trim());
  node.type = "button";
  node.title = label;
  node.setAttribute("aria-label", label);
  node.append(icon(iconName));
  if (action) node.addEventListener("click", action);
  else node.disabled = true;
  return node;
}
function field(label, value) {
  const node = element("div", undefined, "field");
  node.append(element("strong", label), document.createTextNode(value || "—"));
  return node;
}
function setPage(name, title, subtitle) {
  state.page = name;
  pageTitle.textContent = title;
  pageSubtitle.textContent = subtitle;
  status.textContent = "";
  status.className = "";
  content.replaceChildren();
  for (const node of document.querySelectorAll("nav button")) {
    node.classList.toggle("active", node.dataset.page === name);
  }
}
function emptyState(text, iconName = "database") {
  const node = element("div", undefined, "empty");
  const body = element("div");
  body.append(icon(iconName), element("div", text));
  node.append(body);
  return node;
}
function showError(error) {
  status.textContent = error instanceof Error ? error.message : "操作失败";
  status.className = "error";
}
async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-codex-local-csrf"] = state.csrf;
  }
  const response = await fetch(path, { ...options, method, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
async function renderMemories() {
  setPage("memories", "项目知识", "只保存经历本项目工作后形成、未来仍有用的隐性知识。");
  const searchbar = element("div", undefined, "searchbar");
  const search = document.createElement("input");
  search.placeholder = "搜索知识标题、内容、原因或适用场景…";
  search.setAttribute("aria-label", "搜索记忆");
  const workspace = element("div", undefined, "repository-list");
  const runSearch = () => loadMemoryWorkspace(search.value, workspace).catch(showError);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runSearch();
  });
  searchbar.append(icon("magnifying-glass"), search, iconButton("magnifying-glass", "搜索", runSearch));
  content.append(searchbar, workspace);
  await loadMemoryWorkspace("", workspace);
}
async function loadMemoryWorkspace(query, workspace) {
  const [repositoryData, memoryData] = await Promise.all([
    api("/api/repositories"),
    api(`/api/memories?q=${encodeURIComponent(query)}`),
  ]);
  workspace.replaceChildren();
  if (!repositoryData.repositories.length) {
    workspace.append(emptyState("还没有绑定的仓库", "folder-simple"));
    return;
  }
  for (const repository of repositoryData.repositories) {
    const memories = memoryData.memories.filter((memory) => memory.repoId === repository.id);
    workspace.append(repositoryGroup(repository, memories));
  }
}
function repositoryGroup(repository, memories) {
  const section = element("section", undefined, "repository-group");
  const heading = element("div", undefined, "repository-heading");
  const title = element("div", undefined, "repository-title");
  title.append(
    icon("folder-simple"),
    element("strong", repository.displayName),
    element("span", `${repository.memoryCount} 条记忆`, "repository-count"),
  );
  const actions = element("div", undefined, "repository-actions");
  actions.append(
    actionButton(repository.paused ? "恢复采集" : "暂停采集", "secondary", async () => {
      await api(`/api/repositories/${encodeURIComponent(repository.id)}/pause`, {
        method: "POST",
        body: JSON.stringify({ paused: !repository.paused }),
      });
      await renderMemories();
    }, repository.paused ? "play" : "pause"),
    iconButton("trash", "清空仓库记忆", async () => {
      if (!window.confirm("永久删除这个仓库的全部记忆和版本？")) return;
      await api(`/api/repositories/${encodeURIComponent(repository.id)}/memories`, {
        method: "DELETE",
        body: JSON.stringify({ confirm_repo_id: repository.id }),
      });
      await renderMemories();
    }, "danger"),
  );
  heading.append(title, actions);
  const meta = element("div", `${repository.kind} · ${repository.path}`, "repository-meta muted");
  const table = element("div", undefined, "memory-table");
  const tableHead = element("div", undefined, "memory-table-head");
  for (const label of ["标题", "项目知识", "适用场景", "版本", "操作"]) tableHead.append(element("span", label));
  table.append(tableHead);
  if (!memories.length) table.append(element("div", "没有匹配的记忆", "empty-row"));
  for (const memory of memories) table.append(memoryRow(memory));
  section.append(heading, meta, table);
  return section;
}
function memoryRow(memory) {
  const wrapper = element("div", undefined, "memory-item");
  const row = element("div", undefined, "memory-row");
  row.append(
    element("div", memory.card.title, "memory-title"),
    element("div", memory.card.knowledge, "memory-behavior"),
    element("div", memory.card.applicability || "—", "memory-scope"),
    element("div", `v${memory.activeVersion}`, "memory-version"),
  );
  const actions = element("div", undefined, "row-actions");
  actions.append(
    iconButton("clock-counter-clockwise", "查看版本", () => showVersions(wrapper, memory)),
    memory.source.available && memory.source.command
      ? iconButton("copy", "复制来源命令", async () => {
          await navigator.clipboard.writeText(memory.source.command);
          status.textContent = "来源命令已复制";
        })
      : iconButton("copy", "原会话不可用", null),
    iconButton("archive", "归档", async () => {
      await api(`/api/memories/${encodeURIComponent(memory.id)}/archive`, { method: "POST", body: "{}" });
      await renderMemories();
    }),
    iconButton("trash", "硬删除", async () => {
      if (!window.confirm("永久删除正文、版本和候选？此操作不可撤销。")) return;
      await api(`/api/memories/${encodeURIComponent(memory.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm_memory_id: memory.id }),
      });
      await renderMemories();
    }, "danger"),
  );
  row.append(actions);
  wrapper.append(row);
  return wrapper;
}
async function showVersions(wrapper, memory) {
  const existing = wrapper.querySelector(".version-panel");
  if (existing) return existing.remove();
  const { versions } = await api(`/api/memories/${encodeURIComponent(memory.id)}/versions`);
  const panel = element("div", undefined, "version-panel");
  for (const version of versions) {
    const row = element("div", undefined, "version-row");
    row.append(element("strong", `v${version.version}`), element("span", version.card.knowledge));
    if (version.id !== memory.activeVersionId) {
      row.append(actionButton("恢复", "secondary", async () => {
        await api(`/api/memories/${encodeURIComponent(memory.id)}/rollback`, {
          method: "POST",
          body: JSON.stringify({ version_id: version.id }),
        });
        await renderMemories();
      }, "arrow-clockwise"));
    } else row.append(element("span", "当前", "muted"));
    panel.append(row);
  }
  wrapper.append(panel);
}
async function renderModel() {
  setPage("model", "抽取模型", "配置 HTTPS 模型服务，并控制是否自动抽取记忆。");
  const data = await api("/api/model");
  const stack = element("div", undefined, "settings-stack");
  const configuration = element("section", undefined, "settings-group");
  configuration.append(element("h2", "连接配置"), element("p", "Gate/Refiner 在 25 个完成回合或 compact 后提炼项目隐性知识；每日整合只比较同仓 active 卡片。保存后会验证三份严格 Schema。", "muted"));
  const form = element("div", undefined, "form-grid");
  const base = inputWithValue(data.configuration?.base_url || "", "https://example.com/v1");
  const model = inputWithValue(data.configuration?.model || "", "Gate/Refiner 模型名称");
  const key = inputWithValue("", "API Key（不会回显）");
  key.type = "password";
  form.append(labelNode("Base URL", base), labelNode("Gate/Refiner 模型", model), labelNode("API Key", key));
  configuration.append(form, actionButton("保存并测试", "primary", async () => {
    try {
      await api("/api/model/configure", {
        method: "POST",
        body: JSON.stringify({ base_url: base.value, model: model.value, api_key: key.value }),
      });
      await api("/api/model/test", { method: "POST", body: "{}" });
      await renderModel();
      status.textContent = "配置已保存，正式 Schema 验证通过";
    } catch (error) {
      await renderModel();
      showError(error);
    }
  }));
  const automation = element("section", undefined, "settings-group");
  automation.append(
    element("h2", "自动抽取"),
    element("p", `模型验证：${data.strict_schema_verified ? "已通过" : "未通过"} · 当前状态：${data.auto_extract ? "已开启" : "已关闭"}`, "muted"),
    element("p", "开启即代表同意在 25 回合或 compact 检查点发送最多 40,000/80,000 字符的安全对话投影给 Gate/Refiner，并允许每日只发送同仓 active 知识卡检查合并与冲突。Stop 只累计 turn 引用；对话原文不写入本地数据库或日志。", "muted"),
  );
  const actions = element("div", undefined, "actions");
  const toggle = data.auto_extract
    ? actionButton("关闭自动抽取", "secondary", async () => {
      await api("/api/model/pause", { method: "POST", body: "{}" });
      await renderModel();
    })
    : actionButton("开启自动抽取", "primary", async () => {
      await api("/api/model/enable", { method: "POST", body: "{}" });
      await renderModel();
    });
  toggle.disabled = !data.auto_extract && !data.strict_schema_verified;
  actions.append(toggle);
  automation.append(actions);
  if (data.last_error) automation.append(element("p", `最近失败：${data.last_error}`, "error"));
  stack.append(configuration, automation);
  content.append(stack);
}
async function renderHealth() {
  setPage("health", "系统健康", "Hook、Sidecar、SQLite、模型与 CLI 兼容状态。");
  const health = await api("/api/health");
  const list = element("div", undefined, "health-list");
  for (const [key, value] of Object.entries(health)) {
    const row = element("div", undefined, "health-row");
    const healthy = value === "ok" || value === true || value === 0;
    row.append(icon(healthy ? "check-circle" : "warning-circle"), element("div", key, "health-key"), element("div", typeof value === "object" ? JSON.stringify(value) : String(value), "health-value"));
    list.append(row);
  }
  content.append(list);
}
function inputWithValue(value, placeholder) {
  const input = document.createElement("input");
  input.value = value;
  input.placeholder = placeholder;
  return input;
}
function labelNode(text, input) {
  const label = element("label");
  label.append(element("span", text), input);
  return label;
}
