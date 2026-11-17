/* Product-owned profile interaction. Shared helpers/state are provided by app.js. */
window.ProfileUI = {
  mode: "chat",
  dimension: null,
  drafts: {},
  requestId: null,
  render(p) {
    if (!p) return "<p>正在载入个人背景…</p>";
    const current = p.questions.find(
      (q) => q.id === (this.dimension || p.nextDimension),
    );
    const answered = Object.keys(p.facts).length;
    const failures = p.jobs.filter((j) =>
      ["failed", "interrupted"].includes(j.status),
    );
    const intro = `<div class="profile-intro"><div><p class="eyebrow">GETTING TO KNOW YOU</p><h2>先认识你，才能更好地陪你做事。</h2><p>从你愿意分享的部分开始。这里记住的是你的自述，不是给你贴上的标签。</p></div><span class="profile-progress">${answered}<small> / 8 个方面</small></span></div>`;
    const controls = `<div class="profile-controls"><span class="badge ${p.enabled ? "" : "gray"}">${p.enabled ? "主动邀请已开启" : "主动邀请已关闭"}</span><small>${p.enabled ? "未回应时安静等待，正常每七天邀请更新一次。" : "你仍可以随时主动来聊。"}</small><button class="button text" data-action="profile-toggle">${p.enabled ? "关闭主动邀请" : "开启主动邀请"}</button></div>`;
    const tabs = `<div class="profile-tabs" role="tablist" aria-label="回答方式"><button role="tab" aria-selected="${this.mode === "chat"}" data-action="profile-mode" data-mode="chat">聊一聊</button><button role="tab" aria-selected="${this.mode === "form"}" data-action="profile-mode" data-mode="form">一次性填写</button></div>`;
    const fields = p.questions
      .map(
        (q) =>
          `<label>${escape(q.label)}<small>${escape(q.question)}</small><textarea rows="2" maxlength="4000" name="${q.id}" data-profile-field="${q.id}" placeholder="${escape(q.hint)}">${escape(this.drafts[q.id] ?? p.facts[q.id]?.value ?? "")}</textarea></label>`,
      )
      .join("");
    const chat = `<div class="profile-chat"><div class="topic-chips">${p.questions.map((q) => `<button class="topic ${q.id === current?.id ? "selected" : ""}" data-action="profile-topic" data-id="${q.id}" ${p.busy ? "disabled" : ""}>${p.facts[q.id] ? "✓ " : ""}${escape(q.label)}</button>`).join("")}</div><div class="profile-transcript">${p.messages.map((m) => `<div class="message ${m.role}"><b>${m.role === "user" ? `你 · ${escape(p.questions.find((q) => q.id === m.dimension)?.label || "")}` : "mr-on"}</b>${escape(m.body)}</div>`).join("")}</div>${current ? `<div class="profile-question"><span class="eyebrow">${escape(current.label)}</span><h3>${escape(current.question)}</h3><p>${escape(current.hint)}</p></div><form id="profile-chat-form"><label for="profile-answer">你的回答 · ${escape(current.label)}</label><textarea id="profile-answer" data-profile-field="answer-${current.id}" name="text" maxlength="4000" rows="3" required placeholder="按你自己的方式说就好。">${escape(this.drafts["answer-" + current.id] || "")}</textarea><p class="form-note">发送后将原话记在“${escape(current.label)}”，可在右侧查看或用表单修改。</p><div class="actions"><button class="button primary" ${p.busy ? "disabled" : ""}>${p.busy ? "正在回应…" : "发送回答"}</button><button type="button" class="button text" data-action="profile-skip" data-id="${current.id}" ${p.busy ? "disabled" : ""}>暂时跳过</button></div></form>` : `<div class="profile-question"><h3>这轮问题先到这里。</h3><p>你可以点选上方任意方面继续聊，或用一次性表单更新。近期目标和偏好变化时，再告诉我就好。</p><button class="button" data-action="profile-mode" data-mode="form">查看并修改</button></div>`}</div>`;
    const form = `<form id="profile-batch-form" class="profile-batch"><p class="form-note">可以只回答一部分。留空并保存会清除该项；保存会重新开始画像对话，防止旧信息继续影响交流。</p>${fields}<button class="button primary" ${p.busy ? "disabled" : ""}>保存我的回答</button></form>`;
    const cards = p.questions
      .map((q) => {
        const fact = p.facts[q.id];
        return `<article class="profile-fact"><div><h3>${escape(q.label)}</h3><button class="button text" data-action="profile-topic" data-id="${q.id}" ${p.busy ? "disabled" : ""}>${fact ? "再聊聊" : "聊聊"}</button></div><p>${fact?.value ? escape(fact.value) : fact?.skipped ? "你选择暂时跳过。" : "还不了解，等你愿意时再说。"}</p><small>${fact ? `用户${fact.skipped ? "选择" : "自述"} · ${date(fact.updatedAt)}` : "未提供"}</small></article>`;
      })
      .join("");
    return (
      heading("关于我", "让 mr-on 逐渐了解你的目标、习惯和协作方式。") +
      intro +
      controls +
      `<div class="profile-layout"><section class="panel">${tabs}${failures.map((j) => `<div class="profile-error">${escape(j.error)} <button class="button text" data-action="profile-retry" data-id="${j.id}" ${p.busy ? "disabled" : ""}>重试回应</button></div>`).join("")}${this.mode === "chat" ? chat : form}<p class="profile-privacy">${state.config.mode === "demo" ? "当前是离线演示，回复为固定示例，仍会保存你输入的真实文本。" : "真实模型模式会将本次回答和已有画像发给你配置的模型服务。"}目标、兴趣、工作方式、交流偏好和期望帮助会作为后续研究背景；其他信息只用于画像交流。偏好记录不会自动更改系统日程或授予工具权限。</p></section><aside class="profile-memory"><div class="section-head"><h2>我目前了解的你</h2><small>可修改的用户自述</small></div><div class="profile-facts">${cards}</div><div class="profile-forget"><button class="button text" data-action="profile-forget">删除全部画像与交流记录</button><p>会删除画像专属会话并关闭主动邀请，保留监控任务和研究结果。</p></div></aside></div>`
    );
  },
  focus() {
    const active = document.activeElement;
    return active?.dataset.profileField
      ? {
          key: active.dataset.profileField,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;
  },
  restore(focus) {
    if (!focus) return;
    const field = [...document.querySelectorAll("[data-profile-field]")].find(
      (el) => el.dataset.profileField === focus.key,
    );
    if (field) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(focus.start, focus.end);
    }
  },
  async open() {
    view = "profile";
    this.dimension = null;
    render();
    await api("/api/profile/read", {});
    await refresh();
  },
};
document.addEventListener("input", (event) => {
  const key = event.target.dataset.profileField;
  if (key) {
    window.ProfileUI.drafts[key] = event.target.value;
    if (key.startsWith("answer-")) window.ProfileUI.requestId = null;
  }
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action^="profile-"]');
  if (!button) return;
  const ui = window.ProfileUI,
    action = button.dataset.action,
    p = state.profile;
  try {
    if (action === "profile-open") {
      await ui.open();
      return;
    }
    if (action === "profile-mode") {
      ui.mode = button.dataset.mode;
      render();
      return;
    }
    if (action === "profile-topic") {
      ui.dimension = button.dataset.id;
      ui.mode = "chat";
      render();
      return;
    }
    if (action === "profile-forget") {
      $("#forget-profile-dialog").showModal();
      return;
    }
    button.disabled = true;
    if (action === "profile-forget-confirm") {
      await api("/api/profile/forget", {});
      ui.drafts = {};
      ui.requestId = null;
      ui.dimension = null;
      $("#forget-profile-dialog").close();
      toast("画像和专属交流记录已删除");
    }
    if (action === "profile-toggle") {
      await api("/api/profile/preferences", { enabled: !p.enabled });
      toast(p.enabled ? "主动邀请已关闭" : "主动邀请已开启");
    }
    if (action === "profile-snooze") {
      await api("/api/profile/snooze", {});
      toast("明天再提醒你");
    }
    if (action === "profile-skip") {
      await api("/api/profile/skip", { dimension: button.dataset.id });
      ui.dimension = null;
      toast("已跳过，随时可以回来补充");
    }
    if (action === "profile-retry") {
      await api(`/api/profile/jobs/${button.dataset.id}/retry`, {});
      toast("已重新尝试回应");
    }
    await refresh(true);
    button.disabled = false;
  } catch (e) {
    button.disabled = false;
    toast(e.message, true);
  }
});
document.addEventListener("submit", async (event) => {
  if (!["profile-chat-form", "profile-batch-form"].includes(event.target.id))
    return;
  event.preventDefault();
  const ui = window.ProfileUI,
    form = event.target;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    if (form.id === "profile-chat-form") {
      const dimension = ui.dimension || state.profile.nextDimension;
      ui.requestId ??= crypto.randomUUID();
      await api("/api/profile/answers", {
        requestId: ui.requestId,
        dimension,
        text: form.elements.text.value,
      });
      delete ui.drafts["answer-" + dimension];
      ui.dimension = null;
      ui.requestId = null;
      toast("回答已保存，正在回应");
    } else {
      const facts = Object.fromEntries(new FormData(form));
      await api("/api/profile/facts", { facts }, "PATCH");
      ui.drafts = {};
      ui.dimension = null;
      toast("共同背景已更新");
    }
    await refresh(true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
  }
});
const stream = new EventSource("/api/stream");
stream.addEventListener("update", () => void refresh());
