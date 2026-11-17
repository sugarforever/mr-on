const $ = (s) => document.querySelector(s);
const escape = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ],
  );
const date = (n) =>
  n
    ? new Date(n).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
const short = (s) => String(s || "").slice(0, 8);
const names = {
  overview: "工作概览",
  tasks: "监控任务",
  inbox: "收件箱",
  runs: "执行记录",
  events: "事件与 Webhook",
  profile: "关于我",
};
const statuses = {
  queued: "等待执行",
  running: "执行中",
  done: "已完成",
  failed: "执行失败",
  interrupted: "已中断",
  retried: "已重试",
  pending: "待处理",
  cancelled: "已取消",
};
const kinds = { check: "资料检查", message: "用户追问", followup: "后续分析" };
let state = {
  tasks: [],
  runs: [],
  items: [],
  notifications: [],
  messages: [],
  events: [],
  followups: [],
  config: { mode: "demo" },
};
let view = "overview",
  selectedItem = null,
  lastData = "",
  refreshing = false,
  toastTimer;
async function api(path, body, method = "POST") {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "请求失败");
  return result;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").className = error ? "error" : "";
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function tag(status) {
  return `<span class="badge ${["failed", "interrupted"].includes(status) ? "red" : ["queued", "pending"].includes(status) ? "amber" : ""}">${escape(statuses[status] || status)}</span>`;
}
function taskName(id) {
  return state.tasks.find((t) => t.id === id)?.name || "未知任务";
}
function empty(title, text, button = "") {
  return `<div class="empty"><div class="empty-icon">◌</div><h3>${title}</h3><p>${text}</p>${button}</div>`;
}
function taskCard(t) {
  const running = state.runs.find(
    (r) => r.taskId === t.id && r.status === "running",
  );
  return `<article class="task"><div class="task-top"><div class="task-icon">↗</div><div><h3>${escape(t.name)}</h3><div class="task-url" title="${escape(t.url)}">${escape(t.url)}</div></div><span class="badge ${t.paused ? "gray" : ""}">${t.paused ? "已暂停" : running ? "检查中" : "监控中"}</span></div><p class="task-goal">${escape(t.goal)}</p><div class="task-bottom"><span>${t.intervalMinutes < 60 ? `每 ${t.intervalMinutes} 分钟` : t.intervalMinutes === 1440 ? "每天" : `每 ${t.intervalMinutes / 60} 小时`} · ${t.paused ? "计划已暂停" : `下次 ${date(t.nextAt)}`}</span><div class="actions"><button class="button" data-action="edit" data-id="${t.id}">编辑</button><button class="button" data-action="pause" data-id="${t.id}">${t.paused ? "恢复" : "暂停"}</button><button class="button" data-action="run" data-id="${t.id}" ${running ? "disabled" : ""}>${running ? "检查中…" : "立即检查"}</button></div></div></article>`;
}
function allNotifications() {
  return [
    ...state.notifications,
    ...(state.profile?.invitations || [])
      .filter((i) => i.status === "pending")
      .map((i) => ({ ...i, kind: "profile" })),
  ].sort((a, b) => b.createdAt - a.createdAt);
}
function profileBanner() {
  const invitation = state.profile?.invitations.find(
    (i) => i.status === "pending",
  );
  return invitation
    ? `<section class="profile-banner"><div><span class="eyebrow">A CONVERSATION FOR YOU</span><h3>${escape(invitation.title)}</h3><p>${escape(invitation.body)}</p></div><div class="actions"><button class="button primary" data-action="profile-open">开始交流</button><button class="button text" data-action="profile-snooze">明天再说</button></div></section>`
    : "";
}
function notificationCard(n) {
  if (n.kind === "profile")
    return `<div class="inbox-entry profile-invitation" role="button" tabindex="0" data-action="profile-open"><div class="entry-top"><b>${n.read ? "" : '<span class="unread-dot"></span>'}${escape(n.title)}</b><span class="badge">等你回应</span></div><p>${escape(n.body)}</p><div class="entry-bottom"><span>${date(n.createdAt)}</span><span>聊一聊或一次性填写 →</span></div></div>`;
  return `<div class="inbox-entry" role="button" tabindex="0" data-action="item" data-id="${n.itemId}" data-notification="${n.id}"><div class="entry-top"><b>${n.read ? "" : '<span class="unread-dot"></span>'}${escape(n.title)}</b><span class="badge ${state.config.mode === "demo" ? "amber" : ""}">${n.body.includes("离线演示") ? "演示" : "新发现"}</span></div><p>${escape(n.body)}</p><div class="entry-bottom"><span>${date(n.createdAt)}</span><span>查看并继续研究 ↗</span></div></div>`;
}
function runsTable(runs) {
  return runs.length
    ? `<div class="panel table-wrap"><table><thead><tr><th>任务 / 运行</th><th>触发方式</th><th>状态</th><th>结果</th><th>时间</th></tr></thead><tbody>${runs.map((r) => `<tr><td><b>${escape(taskName(r.taskId))}</b><small>${escape(short(r.id))}${r.sessionId ? ` · 会话 ${escape(short(r.sessionId))}` : ""}</small></td><td>${escape(kinds[r.kind])}${r.eventId ? " · 事件" : ""}</td><td>${tag(r.status)}</td><td><div class="run-result" title="${escape(r.error || r.result || "")}">${escape(r.error || r.result || "正在等待执行结果")}</div>${r.itemId ? `<button class="row-link" data-action="item" data-id="${r.itemId}">打开关联事项 →</button>` : ""}${["failed", "interrupted"].includes(r.status) ? `<button class="row-link" data-action="retry" data-id="${r.id}">手动重试 →</button>` : ""}</td><td>${date(r.createdAt)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="panel">${empty("还没有执行记录", "创建任务后，手动检查或等待计划唤醒。")}</div>`;
}
function schedules() {
  const pending = state.followups.filter((f) =>
    ["pending", "queued", "failed", "interrupted"].includes(f.status),
  );
  return pending.length
    ? `<section class="mt"><div class="section-head"><h2>后续分析计划</h2><small>复用事项会话</small></div><div class="panel">${pending.map((f) => `<div class="schedule"><div><button class="row-link" data-action="item" data-id="${f.itemId}">${escape(f.prompt)}</button><small class="inline-copy"> · ${date(f.dueAt)} · ${escape(taskName(f.taskId))}</small></div><div>${tag(f.status)} ${f.status === "pending" ? `<button class="button text" data-action="cancel" data-id="${f.id}">取消</button>` : ""}</div></div>`).join("")}</div></section>`
    : "";
}
function heading(title, description, actions = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`;
}
const newButton =
  '<button class="button primary" data-action="new">＋ 创建任务</button>';
function render() {
  $("#page-name").textContent = names[view];
  $(".nav.active")?.classList.remove("active");
  $(`[data-view="${view}"]`)?.classList.add("active");
  const notifications = allNotifications();
  const unread = notifications.filter((n) => !n.read).length;
  $("#task-count").textContent = state.tasks.length;
  $("#inbox-count").textContent = unread;
  $("#mode-badge").textContent =
    state.config.mode === "demo" ? "离线演示 · 无模型费用" : "真实模型";
  $("#mode-badge").className =
    "badge " + (state.config.mode === "demo" ? "amber" : "");
  $("#service-label").textContent = state.runs.some(
    (r) => r.status === "running",
  )
    ? "正在处理事件"
    : "服务运行中";
  const profileFocus = view === "profile" ? window.ProfileUI?.focus() : null;
  let html = "";
  if (view === "profile") {
    html = window.ProfileUI?.render(state.profile) || "正在载入…";
  } else if (view === "overview") {
    html =
      heading("工作概览", "把持续关注交给 mr-on，把时间留给判断。", newButton) +
      `<section class="hero"><div><p class="eyebrow">ALWAYS ON. ALWAYS IN CONTEXT.</p><h2>让重要变化，主动找到你。</h2><p>定期检查公开资料，记住进展，发现变化后与你继续研究。</p><div class="actions"><button class="button" data-action="demo">体验离线演示 ↗</button><button class="button text" data-action="change">模拟一次资料变化 →</button></div></div><div class="orbital" aria-hidden="true"><span class="mark">m<span></span></span></div></section><section class="stats">${[
        [
          "监控中的任务",
          state.tasks.filter((t) => !t.paused).length,
          "持续关注你的研究目标",
          "◫",
        ],
        ["待阅通知", unread, "无变化时，不打扰", "▣"],
        ["独立研究事项", state.items.length, "每个事项都有自己的会话", "↗"],
        [
          "已完成检查",
          state.runs.filter((r) => r.kind === "check" && r.status === "done")
            .length,
          "计划与事件自动唤醒",
          "◷",
        ],
      ]
        .map(
          ([title, value, note, icon]) =>
            `<div class="stat"><div class="stat-head">${title}<span>${icon}</span></div><div class="stat-value">${value}<small>${title === "待阅通知" ? "条" : "个"}</small></div><div class="stat-note">${note}</div></div>`,
        )
        .join(
          "",
        )}</section><div class="columns"><section><div class="section-head"><h2>正在关注</h2><button class="button text" data-view="tasks">全部任务 →</button></div><div class="panel">${state.tasks.length ? state.tasks.slice(0, 3).map(taskCard).join("") : empty("从一份资料开始", "添加项目文档、版本发布页或其他公开资料，告诉 mr-on 你关心什么。", newButton)}</div><div class="subtle-box"><b>有变化时深入，无变化时安静。</b>周期检查独立执行。发现新资料版本后创建研究事项，追问和计划跟进都会回到同一个会话。</div></section><section><div class="section-head"><h2>最新发现 ${unread ? `<span class="badge">${unread} 未读</span>` : ""}</h2><button class="button text" data-view="inbox">收件箱 →</button></div><div class="panel">${notifications.length ? notifications.slice(0, 3).map(notificationCard).join("") : empty("暂时没有新变化", "首次读取会建立基线。之后发现正文变化，结果会出现在这里。")}</div><div class="subtle-box"><b>${state.config.mode === "demo" ? "当前为离线演示模式" : "模型已连接"}</b>${state.config.mode === "demo" ? "试试「体验离线演示」，再模拟一次资料变化。回复来自固定 fixture，不代表真实模型研究。" : `使用 ${escape(state.config.model)}。模型只可读取当前任务资料，不具备发布或外部发送能力。`}</div></section></div>${schedules()}<section class="mt"><div class="section-head"><h2>最近执行</h2><button class="button text" data-view="runs">完整记录 →</button></div>${runsTable(state.runs.slice(0, 5))}</section>`;
  } else if (view === "tasks")
    html =
      heading(
        "监控任务",
        "每个任务一个长期目标，让检查按计划发生。",
        newButton,
      ) +
      `<div class="full-task-grid">${state.tasks.length ? state.tasks.map(taskCard).join("") : empty("还没有任务", "添加你想持续关注的公开资料。", newButton)}</div>${schedules()}`;
  else if (view === "inbox")
    html =
      heading("收件箱", `${unread} 条未读通知 · 所有通知仅保存在应用内`) +
      `<div class="panel">${notifications.length ? notifications.map(notificationCard).join("") : empty("一切安静", "新变化和计划跟进的结果会出现在这里。")}</div>`;
  else if (view === "runs")
    html =
      heading(
        "执行记录",
        "查看触发、结果和会话关联。失败或中断的运行可手动重试。",
      ) +
      runsTable(state.runs) +
      schedules();
  else if (view === "events")
    html =
      heading(
        "事件与 Webhook",
        "从外部事件唤醒任务，同一事件 ID 只接收一次。",
      ) +
      `<section class="panel event-setup"><h3>本地调用示例</h3><p class="section-copy">Basic 认证用户名为 events。令牌从本机数据目录读取；不会回传浏览器。将 taskId 替换为目标任务 ID。事件内容仅记录，不作为指令执行。</p><pre class="code-block" id="webhook-example"></pre><button class="button" data-action="copy">复制调用示例</button><p class="inline-copy">默认数据目录为 .data；使用 MR_ON_DATA 时调整令牌文件路径。该入口仅监听本机，外部系统需通过你自己配置的受认证代理接入。</p></section><section class="mt"><div class="section-head"><h2>持久事件收件记录</h2><small>eventId 全局去重</small></div>${state.events.length ? `<div class="panel table-wrap"><table><thead><tr><th>事件 ID</th><th>关联任务</th><th>状态</th><th>接收时间</th></tr></thead><tbody>${state.events.map((e) => `<tr><td>${escape(e.id)}</td><td>${escape(taskName(e.taskId))}</td><td>${tag(e.status)}</td><td>${date(e.createdAt)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="panel">${empty("等待第一个事件", "发送上面的请求即可触发一次资料检查。")}</div>`}</section>`;
  if (view === "overview")
    html = html.replace(
      '<section class="hero">',
      profileBanner() + '<section class="hero">',
    );
  $("#main").innerHTML = html;
  if (view === "profile") window.ProfileUI?.restore(profileFocus);
  if (view === "events") $("#webhook-example").textContent = webhookExample();
  if (selectedItem && $("#item-dialog").open) renderItem();
}
function webhookExample() {
  return `TOKEN="$(cat \"${".data/webhook-token"}\")"\ncurl -X POST '${location.origin}/api/webhook' \\\n  -u "events:$TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ eventId: "release-2026-001", taskId: state.tasks[0]?.id || "替换为任务 ID", payload: { source: "release-hook" } })}'`;
}
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await api("/api/state");
    const json = JSON.stringify(next);
    state = next;
    if (force || json !== lastData) {
      lastData = json;
      render();
    }
    $("#service-label").title = "本地服务已连接";
  } catch (e) {
    $("#service-label").textContent = "连接已断开";
    if (force) toast(e.message, true);
  } finally {
    refreshing = false;
  }
}
function openTask(id) {
  const form = $("#task-form");
  form.reset();
  form.elements.id.value = "";
  $("#task-dialog-title").textContent = id ? "编辑监控任务" : "创建监控任务";
  if (id) {
    const t = state.tasks.find((t) => t.id === id);
    for (const key of ["id", "name", "url", "goal", "intervalMinutes"])
      form.elements[key].value = t[key];
    if (!form.elements.intervalMinutes.value) {
      const option = new Option(
        `每 ${t.intervalMinutes} 分钟`,
        t.intervalMinutes,
      );
      form.elements.intervalMinutes.add(option);
      form.elements.intervalMinutes.value = t.intervalMinutes;
    }
  }
  $("#task-dialog").showModal();
}
function openSettings() {
  const form = $("#settings-form");
  for (const key of ["mode", "baseUrl", "model"])
    form.elements[key].value = state.config[key];
  form.elements.apiKey.value = "";
  form.elements.apiKey.placeholder = state.config.hasKey
    ? "已有凭据，留空保留"
    : "输入 API Key";
  $("#settings-dialog").showModal();
}
function renderItem() {
  const item = state.items.find((i) => i.id === selectedItem);
  if (!item) return;
  $("#item-title").textContent = item.title;
  $("#item-meta").innerHTML =
    `<span class="badge">${escape(taskName(item.taskId))}</span> <small>${date(item.createdAt)} · 来源正文已更新</small>`;
  const messages = state.messages.filter((m) => m.itemId === item.id).reverse();
  const pending = state.runs.filter(
    (r) => r.itemId === item.id && ["running", "queued"].includes(r.status),
  );
  $("#item-content").innerHTML =
    `<div class="summary">${escape(item.summary)}</div>${messages.map((m) => `<div class="message ${m.role}"><b>${m.role === "user" ? "你" : "mr-on"}</b>${escape(m.body)}</div>`).join("")}${pending.length ? '<p class="section-copy">正在同一事项会话中处理…</p>' : ""}`;
  $("#item-routing").textContent =
    `taskId: ${item.taskId}\nitemId: ${item.id}\nrunId: ${item.runId}\nPi sessionId: ${item.sessionId}`;
  $("#item-routing").className = "summary";
}
async function openItem(id, notification) {
  selectedItem = id;
  renderItem();
  if (!$("#item-dialog").open) {
    $("#message-form").reset();
    $("#followup-form").reset();
    const due = new Date(Date.now() + 3600000);
    due.setMinutes(due.getMinutes() - due.getTimezoneOffset());
    $("#followup-form").elements.dueAt.value = due.toISOString().slice(0, 16);
    $("#item-dialog").showModal();
  }
  if (notification) {
    await api(`/api/notifications/${notification}/read`, {});
    await refresh();
  }
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button,[data-action],[data-view]");
  if (!button) return;
  if (button.hasAttribute("data-close")) {
    button.closest("dialog").close();
    return;
  }
  if (button.dataset.view) {
    view = button.dataset.view;
    render();
    return;
  }
  const action = button.dataset.action,
    id = button.dataset.id;
  if (!action || action.startsWith("profile-")) return;
  try {
    if (action === "new") openTask();
    else if (action === "edit") openTask(id);
    else if (action === "settings") openSettings();
    else if (action === "item") await openItem(id, button.dataset.notification);
    else if (action === "refresh") await refresh(true);
    else if (action === "copy") {
      await navigator.clipboard.writeText(webhookExample());
      toast("调用示例已复制");
    } else {
      button.disabled = true;
      if (action === "pause") {
        const task = state.tasks.find((t) => t.id === id);
        await api(`/api/tasks/${id}`, { paused: !task.paused }, "PATCH");
        toast(task.paused ? "任务已恢复" : "任务已暂停，当前运行会继续完成");
      }
      if (action === "run") {
        await api(`/api/tasks/${id}/run`, {});
        toast("已加入检查队列");
      }
      if (action === "retry") {
        await api(`/api/runs/${id}/retry`, {});
        toast("已创建新的重试运行");
      }
      if (action === "demo") {
        await api("/api/demo/start", {});
        toast("演示任务已载入，正在建立资料基线");
      }
      if (action === "change") {
        await api("/api/demo/change", {});
        toast("演示资料已更新，正在分析变化");
      }
      if (action === "cancel") {
        await api(`/api/followups/${id}/cancel`, {});
        toast("跟进计划已取消");
      }
      await refresh(true);
      button.disabled = false;
    }
  } catch (e) {
    button.disabled = false;
    toast(e.message, true);
  }
});
document.addEventListener("keydown", (e) => {
  if (
    ["Enter", " "].includes(e.key) &&
    e.target.matches('[role="button"][data-action]')
  ) {
    e.preventDefault();
    e.target.click();
  }
});
async function submit(form, fn) {
  const button = form.querySelector('button[type="submit"],button:not([type])');
  if (button) button.disabled = true;
  try {
    await fn();
    await refresh(true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}
$("#task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  void submit(form, async () => {
    const data = Object.fromEntries(new FormData(form));
    const id = data.id;
    delete data.id;
    data.intervalMinutes = Number(data.intervalMinutes);
    await api(
      id ? `/api/tasks/${id}` : "/api/tasks",
      data,
      id ? "PATCH" : "POST",
    );
    $("#task-dialog").close();
    toast("任务已保存");
  });
});
$("#settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void submit(e.target, async () => {
    await api("/api/config", Object.fromEntries(new FormData(e.target)));
    e.target.elements.apiKey.value = "";
    $("#settings-dialog").close();
    toast("模型设置已保存");
  });
});
$("#message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void submit(e.target, async () => {
    await api(
      `/api/items/${selectedItem}/messages`,
      Object.fromEntries(new FormData(e.target)),
    );
    e.target.reset();
    toast("已发送至当前事项会话");
  });
});
$("#followup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void submit(e.target, async () => {
    const data = Object.fromEntries(new FormData(e.target));
    data.dueAt = new Date(data.dueAt).getTime();
    await api(`/api/items/${selectedItem}/followups`, data);
    toast("后续分析已安排");
  });
});
void refresh(true);
setInterval(() => void refresh(), 2000);
