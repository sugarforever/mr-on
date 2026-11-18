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
    ? new Date(n).toLocaleString("en-GB", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
const short = (s) => String(s || "").slice(0, 8);
const names = {
  overview: "Overview",
  tasks: "Monitors",
  inbox: "Inbox",
  runs: "Run history",
  events: "Events & Webhook",
  profile: "About me",
};
const statuses = {
  queued: "Queued",
  running: "Running",
  done: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  retried: "Retried",
  pending: "Pending",
  cancelled: "Cancelled",
};
const kinds = {
  check: "Source check",
  message: "Follow-up question",
  followup: "Follow-up analysis",
};
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
  toastTimer,
  lastConnectedAt = null,
  connected = false;
const channelClientId =
  sessionStorage.getItem("channelClientId") || crypto.randomUUID();
sessionStorage.setItem("channelClientId", channelClientId);
async function api(path, body, method = "POST") {
  const response = await fetch(
    path,
    body === undefined
      ? { headers: { "X-Mr-Client": channelClientId } }
      : {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Mr-Client": channelClientId,
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Request failed");
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
  return state.tasks.find((t) => t.id === id)?.name || "Unknown monitor";
}
function empty(title, text, button = "") {
  return `<div class="empty"><div class="empty-icon">◌</div><h3>${title}</h3><p>${text}</p>${button}</div>`;
}
function taskCard(t) {
  const running = state.runs.find(
    (r) => r.taskId === t.id && r.status === "running",
  );
  return `<article class="task"><div class="task-top"><div class="task-icon">↗</div><div><h3>${escape(t.name)}</h3><div class="task-url" title="${escape(t.url)}">${escape(t.url)}</div></div><span class="badge ${t.paused ? "gray" : ""}">${t.paused ? "Paused" : running ? "Checking" : "Monitoring"}</span></div><p class="task-goal">${escape(t.goal)}</p><div class="task-bottom"><span>${t.intervalMinutes < 60 ? `Every ${t.intervalMinutes} minutes` : t.intervalMinutes === 60 ? "Hourly" : t.intervalMinutes === 1440 ? "Daily" : `Every ${t.intervalMinutes / 60} hours`} · ${t.paused ? "Schedule paused" : `Next ${date(t.nextAt)}`}</span><div class="actions"><button class="button" data-action="edit" data-id="${t.id}">Edit</button><button class="button" data-action="pause" data-id="${t.id}">${t.paused ? "Resume" : "Pause"}</button><button class="button" data-action="run" data-id="${t.id}" ${running ? "disabled" : ""}>${running ? "Checking…" : "Check now"}</button></div></div></article>`;
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
    ? `<section class="profile-banner"><div><span class="eyebrow">A CONVERSATION FOR YOU</span><h3>${escape(invitation.title)}</h3><p>${escape(invitation.body)}</p></div><div class="actions"><button class="button primary" data-action="profile-open">Start a conversation</button><button class="button text" data-action="profile-snooze">Maybe tomorrow</button></div></section>`
    : "";
}
function notificationCard(n) {
  if (n.kind === "profile")
    return `<div class="inbox-entry profile-invitation" role="button" tabindex="0" data-action="profile-open"><div class="entry-top"><b>${n.read ? "" : '<span class="unread-dot"></span>'}${escape(n.title)}</b><span class="badge">Awaiting your reply</span></div><p>${escape(n.body)}</p><div class="entry-bottom"><span>${date(n.createdAt)}</span><span>Chat or fill in a form →</span></div></div>`;
  return `<div class="inbox-entry" role="button" tabindex="0" data-action="item" data-id="${n.itemId}" data-notification="${n.id}"><div class="entry-top"><b>${n.read ? "" : '<span class="unread-dot"></span>'}${escape(n.title)}</b><span class="badge ${state.config.mode === "demo" ? "amber" : ""}">${n.body.includes("Offline demo") ? "Demo" : "New finding"}</span></div><p>${escape(n.body)}</p><div class="entry-bottom"><span>${date(n.createdAt)}</span><span>View and continue research ↗</span></div></div>`;
}
function runsTable(runs) {
  return runs.length
    ? `<div class="panel table-wrap"><table><thead><tr><th>Monitor / Run</th><th>Trigger</th><th>Status</th><th>Result</th><th>Time</th></tr></thead><tbody>${runs.map((r) => `<tr><td><b>${escape(taskName(r.taskId))}</b><small>${escape(short(r.id))}${r.sessionId ? ` · Session ${escape(short(r.sessionId))}` : ""}</small></td><td>${escape(kinds[r.kind])}${r.eventId ? " · Event" : ""}</td><td>${tag(r.status)}</td><td><div class="run-result" title="${escape(r.error || r.result || "")}">${escape(r.error || r.result || "Waiting for results")}</div>${r.itemId ? `<button class="row-link" data-action="item" data-id="${r.itemId}">Open research thread →</button>` : ""}${["failed", "interrupted"].includes(r.status) ? `<button class="row-link" data-action="retry" data-id="${r.id}">Retry manually →</button>` : ""}</td><td>${date(r.createdAt)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="panel">${empty("No runs yet", "Create a monitor, then check manually or wait for its schedule.")}</div>`;
}
function schedules() {
  const pending = state.followups.filter((f) =>
    ["pending", "queued", "failed", "interrupted"].includes(f.status),
  );
  return pending.length
    ? `<section class="mt"><div class="section-head"><h2>Scheduled follow-ups</h2><small>Continue the same research thread</small></div><div class="panel">${pending.map((f) => `<div class="schedule"><div><button class="row-link" data-action="item" data-id="${f.itemId}">${escape(f.prompt)}</button><small class="inline-copy"> · ${date(f.dueAt)} · ${escape(taskName(f.taskId))}</small></div><div>${tag(f.status)} ${f.status === "pending" ? `<button class="button text" data-action="cancel" data-id="${f.id}">Cancel</button>` : ""}</div></div>`).join("")}</div></section>`
    : "";
}
function heading(title, description, actions = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`;
}
const newButton =
  '<button class="button primary" data-action="new">＋ Create monitor</button>';
function render() {
  $("#page-name").textContent = names[view];
  $(".nav.active")?.classList.remove("active");
  $(`[data-view="${view}"]`)?.classList.add("active");
  const notifications = allNotifications();
  const unread = notifications.filter((n) => !n.read).length;
  $("#task-count").textContent = state.tasks.length;
  $("#inbox-count").textContent = unread;
  $("#mode-badge").textContent =
    state.config.mode === "demo"
      ? "Offline demo · No model costs"
      : "Live model";
  $("#mode-badge").className =
    "badge " + (state.config.mode === "demo" ? "amber" : "");
  $("#service-label").textContent = !connected
    ? "Disconnected · Status unknown"
    : !state.runtime?.ready
      ? "Scheduler not ready"
      : state.runtime.running
        ? "Processing events"
        : "Background service running";
  $("#service-detail").textContent = connected
    ? `Heartbeat ${date(state.runtime?.lastTickAt)} · Queued ${state.runtime?.queued ?? 0}`
    : `Last connected ${date(lastConnectedAt)}`;
  const profileFocus = view === "profile" ? window.ProfileUI?.focus() : null;
  let html = "";
  if (view === "profile") {
    html = window.ProfileUI?.render(state.profile) || "Loading…";
  } else if (view === "overview") {
    html =
      heading(
        "Overview",
        "Let mr-on keep watch so you can focus on decisions.",
        newButton,
      ) +
      `<section class="hero"><div><p class="eyebrow">ALWAYS ON. ALWAYS IN CONTEXT.</p><h2>Stay ahead of the changes that matter.</h2><p>Monitor public sources, keep track of progress, and explore changes together.</p><div class="actions"><button class="button" data-action="demo">Try the offline demo ↗</button><button class="button text" data-action="change">Simulate a source change →</button></div></div><div class="orbital" aria-hidden="true"><span class="mark">m<span></span></span></div></section><section class="stats">${[
        [
          "Active monitors",
          state.tasks.filter((t) => !t.paused).length,
          "Keep your research goals in view",
          "◫",
        ],
        ["Unread notifications", unread, "Quiet when nothing changes", "▣"],
        [
          "Research threads",
          state.items.length,
          "A separate conversation for each finding",
          "↗",
        ],
        [
          "Completed checks",
          state.runs.filter((r) => r.kind === "check" && r.status === "done")
            .length,
          "Triggered by schedules and events",
          "◷",
        ],
      ]
        .map(
          ([title, value, note, icon]) =>
            `<div class="stat"><div class="stat-head">${title}<span>${icon}</span></div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`,
        )
        .join(
          "",
        )}</section><div class="columns"><section><div class="section-head"><h2>Watching</h2><button class="button text" data-view="tasks">All monitors →</button></div><div class="panel">${state.tasks.length ? state.tasks.slice(0, 3).map(taskCard).join("") : empty("Start with a source", "Add project documentation, a release page, or another public source and tell mr-on what matters to you.", newButton)}</div><div class="subtle-box"><b>Explore changes. Stay quiet otherwise.</b>Checks run independently. A new source version opens a research thread, where questions and scheduled follow-ups continue.</div></section><section><div class="section-head"><h2>Latest findings ${unread ? `<span class="badge">${unread} Unread</span>` : ""}</h2><button class="button text" data-view="inbox">Inbox →</button></div><div class="panel">${notifications.length ? notifications.slice(0, 3).map(notificationCard).join("") : empty("No changes yet", "The first read establishes a baseline. Results appear here when the source text changes.")}</div><div class="subtle-box"><b>${state.config.mode === "demo" ? "Offline demo mode" : "Model connected"}</b>${state.config.mode === "demo" ? "Try the offline demo, then simulate a source change. Replies are fixed examples, not live model research." : `Using ${escape(state.config.model)}. The model can only read this monitor's source; it cannot publish or send external messages.`}</div></section></div>${schedules()}<section class="mt"><div class="section-head"><h2>Recent runs</h2><button class="button text" data-view="runs">Full history →</button></div>${runsTable(state.runs.slice(0, 5))}</section>`;
  } else if (view === "tasks")
    html =
      heading(
        "Monitors",
        "Give each monitor a lasting goal and a schedule.",
        newButton,
      ) +
      `<div class="full-task-grid">${state.tasks.length ? state.tasks.map(taskCard).join("") : empty("No monitors yet", "Add a public source you want to keep watching.", newButton)}</div>${schedules()}`;
  else if (view === "inbox")
    html =
      heading(
        "Inbox",
        `${unread} unread notifications · All notifications stay in this app`,
      ) +
      `<div class="panel">${notifications.length ? notifications.map(notificationCard).join("") : empty("All quiet", "Source changes and scheduled follow-up results appear here.")}</div>`;
  else if (view === "runs")
    html =
      heading(
        "Run history",
        "Review triggers, results, and linked conversations. Retry failed or interrupted runs manually.",
      ) +
      runsTable(state.runs) +
      schedules();
  else if (view === "events")
    html =
      heading(
        "Events & Webhook",
        "Trigger monitors with external events. Each event ID is accepted once.",
      ) +
      `<section class="panel event-setup"><h3>Local request example</h3><p class="section-copy">Basic Use events as the authentication username. Read the token from the local data directory; it is never returned to the browser. Replace taskId with your monitor ID. Event content is recorded, never executed as instructions.</p><pre class="code-block" id="webhook-example"></pre><button class="button" data-action="copy">Copy request example</button><p class="inline-copy">Default data directory: .data; when using MR_ON_DATA , adjust the token file path. This endpoint listens locally; external systems require an authenticated proxy you configure.</p></section><section class="mt"><div class="section-head"><h2>Persisted event inbox</h2><small>eventId globally deduplicated</small></div>${state.events.length ? `<div class="panel table-wrap"><table><thead><tr><th>Event ID</th><th>Monitor</th><th>Status</th><th>Received</th></tr></thead><tbody>${state.events.map((e) => `<tr><td>${escape(e.id)}</td><td>${escape(taskName(e.taskId))}</td><td>${tag(e.status)}</td><td>${date(e.createdAt)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="panel">${empty("Waiting for the first event", "Send the request above to trigger a source check.")}</div>`}</section>`;
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
  return `TOKEN="$(cat \"${".data/webhook-token"}\")"\ncurl -X POST '${location.origin}/api/webhook' \\\n  -u "events:$TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ eventId: "release-2026-001", taskId: state.tasks[0]?.id || "REPLACE_WITH_MONITOR_ ID", payload: { source: "release-hook" } })}'`;
}
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await api("/api/state");
    const activeItem = selectedItem;
    if (activeItem && $("#item-dialog").open) {
      const history = await api(
        `/api/channel/conversations/research:${activeItem}`,
      );
      next.messages = [
        ...next.messages.filter((m) => m.itemId !== activeItem),
        ...history.messages.slice().reverse(),
      ];
    }
    const json = JSON.stringify(next);
    state = next;
    connected = true;
    lastConnectedAt = Date.now();
    if (force || json !== lastData) {
      lastData = json;
      render();
    }
    $("#service-label").title =
      `Started ${date(state.runtime?.startedAt)}；Last successful check ${date(state.runtime?.lastCheckAt)}；Last completed ${date(state.runtime?.lastFinishedAt)}；Last failed ${date(state.runtime?.lastFailureAt)}`;
  } catch (e) {
    connected = false;
    $("#service-label").textContent = "Disconnected · Status unknown";
    $("#service-detail").textContent =
      `Last connected ${date(lastConnectedAt)}`;
    if (force) toast(e.message, true);
  } finally {
    refreshing = false;
  }
}
function openTask(id) {
  const form = $("#task-form");
  form.reset();
  form.elements.id.value = "";
  $("#task-dialog-title").textContent = id ? "Edit monitor" : "Create monitor";
  if (id) {
    const t = state.tasks.find((t) => t.id === id);
    for (const key of ["id", "name", "url", "goal", "intervalMinutes"])
      form.elements[key].value = t[key];
    if (!form.elements.intervalMinutes.value) {
      const option = new Option(
        `Every ${t.intervalMinutes} minutes`,
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
    ? "Credentials saved; leave blank to keep"
    : "Enter API Key";
  $("#settings-dialog").showModal();
}
function renderItem() {
  const item = state.items.find((i) => i.id === selectedItem);
  if (!item) return;
  $("#item-title").textContent = item.title;
  $("#item-meta").innerHTML =
    `<span class="badge">${escape(taskName(item.taskId))}</span> <small>${date(item.createdAt)} · Source text updated</small>`;
  const messages = state.messages.filter((m) => m.itemId === item.id).reverse();
  const pending = state.runs.filter(
    (r) => r.itemId === item.id && ["running", "queued"].includes(r.status),
  );
  $("#item-content").innerHTML =
    `<div class="summary">${escape(item.summary)}</div>${messages.map((m) => `<div class="message ${m.role}"><b>${m.role === "user" ? "You" : "mr-on"}</b>${escape(m.body)}</div>`).join("")}${pending.length ? '<p class="section-copy">Processing in the same research thread…</p>' : ""}`;
  $("#item-routing").textContent =
    `taskId: ${item.taskId}\nitemId: ${item.id}\nrunId: ${item.runId}\nPi sessionId: ${item.sessionId}`;
  $("#item-routing").className = "summary";
}
async function openItem(id, notification) {
  selectedItem = id;
  watchConversation(`research:${id}`);
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
      toast("Request example copied");
    } else {
      button.disabled = true;
      if (action === "pause") {
        const task = state.tasks.find((t) => t.id === id);
        await api(`/api/tasks/${id}`, { paused: !task.paused }, "PATCH");
        toast(
          task.paused
            ? "Monitor resumed"
            : "Monitor paused; the current run will finish",
        );
      }
      if (action === "run") {
        await api(`/api/tasks/${id}/run`, {});
        toast("Check queued");
      }
      if (action === "retry") {
        await api(`/api/runs/${id}/retry`, {});
        toast("Retry run created");
      }
      if (action === "demo") {
        await api("/api/demo/start", {});
        toast("Demo monitor loaded; establishing a baseline");
      }
      if (action === "change") {
        await api("/api/demo/change", {});
        toast("Demo source updated; analyzing changes");
      }
      if (action === "cancel") {
        await api(`/api/followups/${id}/cancel`, {});
        toast("Follow-up cancelled");
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
    toast("Monitor saved");
  });
});
$("#settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void submit(e.target, async () => {
    await api("/api/config", Object.fromEntries(new FormData(e.target)));
    e.target.elements.apiKey.value = "";
    $("#settings-dialog").close();
    toast("Model settings saved");
  });
});
$("#message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void submit(e.target, async () => {
    await api(
      `/api/channel/conversations/research:${selectedItem}/messages`,
      pendingChannelMessage(
        `research:${selectedItem}`,
        Object.fromEntries(new FormData(e.target)),
      ),
    );
    sessionStorage.removeItem(`channelPending:research:${selectedItem}`);
    e.target.reset();
    toast("Sent to this research thread");
  });
});
$("#followup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void submit(e.target, async () => {
    const data = Object.fromEntries(new FormData(e.target));
    data.dueAt = new Date(data.dueAt).getTime();
    await api(`/api/items/${selectedItem}/followups`, data);
    toast("Follow-up scheduled");
  });
});
void refresh(true);
setInterval(() => void refresh(), 2000);

// Keep a stable request ID after a lost HTTP acceptance; altered text is a new request.
function pendingChannelMessage(id, input) {
  const key = `channelPending:${id}`;
  let prior;
  try {
    prior = JSON.parse(sessionStorage.getItem(key));
  } catch {}
  const payload = JSON.stringify(input);
  if (!prior || prior.payload !== payload)
    prior = { payload, requestId: crypto.randomUUID() };
  sessionStorage.setItem(key, JSON.stringify(prior));
  return { ...input, requestId: prior.requestId };
}
let conversationStream;
function watchConversation(id) {
  conversationStream?.close();
  const key = `channelCursor:${id}`;
  const cursor = sessionStorage.getItem(key);
  conversationStream = new EventSource(
    `/api/channel/conversations/${encodeURIComponent(id)}/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  const recover = async (event) => {
    // Refresh replaces committed history by stable IDs, avoiding append duplicates.
    await refresh(true);
    if (connected && event.lastEventId)
      sessionStorage.setItem(key, event.lastEventId);
  };
  conversationStream.addEventListener("change", recover);
  conversationStream.addEventListener("snapshot", recover);
}
$("#item-dialog").addEventListener("close", () => conversationStream?.close());
