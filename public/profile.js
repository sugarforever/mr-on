/* Product-owned profile interaction. Shared helpers/state are provided by app.js. */
window.ProfileUI = {
  mode: "chat",
  dimension: null,
  drafts: {},
  requestId: null,
  render(p) {
    if (!p) return "<p>Loading your profile…</p>";
    const current = p.questions.find(
      (q) => q.id === (this.dimension || p.nextDimension),
    );
    const answered = Object.keys(p.facts).length;
    const failures = p.jobs.filter((j) =>
      ["failed", "interrupted"].includes(j.status),
    );
    const intro = `<div class="profile-intro"><div><p class="eyebrow">GETTING TO KNOW YOU</p><h2>Better collaboration starts with getting to know you.</h2><p>Share what you feel comfortable sharing. These are your own words, not labels assigned to you.</p></div><span class="profile-progress">${answered}<small> / 8 topics</small></span></div>`;
    const controls = `<div class="profile-controls"><span class="badge ${p.enabled ? "" : "gray"}">${p.enabled ? "Invitations enabled" : "Invitations disabled"}</span><small>${p.enabled ? "We wait quietly for your reply and normally invite updates every seven days." : "You can start a conversation anytime."}</small><button class="button text" data-action="profile-toggle">${p.enabled ? "Disable invitations" : "Enable invitations"}</button></div>`;
    const tabs = `<div class="profile-tabs" role="tablist" aria-label="Response format"><button role="tab" aria-selected="${this.mode === "chat"}" data-action="profile-mode" data-mode="chat">Chat</button><button role="tab" aria-selected="${this.mode === "form"}" data-action="profile-mode" data-mode="form">Fill in a form</button></div>`;
    const fields = p.questions
      .map(
        (q) =>
          `<label>${escape(q.label)}<small>${escape(q.question)}</small><textarea rows="2" maxlength="4000" name="${q.id}" data-profile-field="${q.id}" placeholder="${escape(q.hint)}">${escape(this.drafts[q.id] ?? p.facts[q.id]?.value ?? "")}</textarea></label>`,
      )
      .join("");
    const chat = `<div class="profile-chat"><div class="topic-chips">${p.questions.map((q) => `<button class="topic ${q.id === current?.id ? "selected" : ""}" data-action="profile-topic" data-id="${q.id}" ${p.busy ? "disabled" : ""}>${p.facts[q.id] ? "✓ " : ""}${escape(q.label)}</button>`).join("")}</div><div class="profile-transcript">${p.messages.map((m) => `<div class="message ${m.role}"><b>${m.role === "user" ? `You · ${escape(p.questions.find((q) => q.id === m.dimension)?.label || "")}` : "mr-on"}</b>${escape(m.body)}</div>`).join("")}</div>${current ? `<div class="profile-question"><span class="eyebrow">${escape(current.label)}</span><h3>${escape(current.question)}</h3><p>${escape(current.hint)}</p></div><form id="profile-chat-form"><label for="profile-answer">Your answer · ${escape(current.label)}</label><textarea id="profile-answer" data-profile-field="answer-${current.id}" name="text" maxlength="4000" rows="3" required placeholder="Tell us in your own words.">${escape(this.drafts["answer-" + current.id] || "")}</textarea><p class="form-note">Your words will be saved under “${escape(current.label)}”. View them on the right or edit them in the form.</p><div class="actions"><button class="button primary" ${p.busy ? "disabled" : ""}>${p.busy ? "Responding…" : "Send answer"}</button><button type="button" class="button text" data-action="profile-skip" data-id="${current.id}" ${p.busy ? "disabled" : ""}>Skip for now</button></div></form>` : `<div class="profile-question"><h3>That is all for now.</h3><p>Choose a topic above to continue, or update your answers in the form. Come back whenever your goals or preferences change.</p><button class="button" data-action="profile-mode" data-mode="form">Review and edit</button></div>`}</div>`;
    const form = `<form id="profile-batch-form" class="profile-batch"><p class="form-note">Answer only what you want. Saving an empty field clears it. Saving starts a fresh profile conversation so outdated information no longer affects replies.</p>${fields}<button class="button primary" ${p.busy ? "disabled" : ""}>Save my answers</button></form>`;
    const cards = p.questions
      .map((q) => {
        const fact = p.facts[q.id];
        return `<article class="profile-fact"><div><h3>${escape(q.label)}</h3><button class="button text" data-action="profile-topic" data-id="${q.id}" ${p.busy ? "disabled" : ""}>${fact ? "Talk more" : "Talk"}</button></div><p>${fact?.value ? escape(fact.value) : fact?.skipped ? "You chose to skip for now." : "Not shared yet. Tell us whenever you are ready."}</p><small>${fact ? `User ${fact.skipped ? "choice" : "statement"} · ${date(fact.updatedAt)}` : "Not provided"}</small></article>`;
      })
      .join("");
    return (
      heading(
        "About me",
        "Help mr-on learn your goals, habits, and collaboration preferences.",
      ) +
      intro +
      controls +
      `<div class="profile-layout"><section class="panel">${tabs}${failures.map((j) => `<div class="profile-error">${escape(j.error)} <button class="button text" data-action="profile-retry" data-id="${j.id}" ${p.busy ? "disabled" : ""}>Retry reply</button></div>`).join("")}${this.mode === "chat" ? chat : form}<p class="profile-privacy">${state.config.mode === "demo" ? "Offline demo replies are fixed examples. Your actual answers are still saved." : "Live mode sends your answer and existing profile to your configured model provider."}Goals, interests, working style, communication preferences, and desired support inform future research. Other details are only used in profile conversations. Preferences do not change schedules or grant tool permissions.</p></section><aside class="profile-memory"><div class="section-head"><h2>What I know about you</h2><small>Your statements, editable anytime</small></div><div class="profile-facts">${cards}</div><div class="profile-forget"><button class="button text" data-action="profile-forget">Delete profile and conversations</button><p>Deletes profile conversations and disables invitations. Monitors and research results are kept.</p></div></aside></div>`
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
      toast("Profile and conversations deleted");
    }
    if (action === "profile-toggle") {
      await api("/api/profile/preferences", { enabled: !p.enabled });
      toast(p.enabled ? "Invitations disabled" : "Invitations enabled");
    }
    if (action === "profile-snooze") {
      await api("/api/profile/snooze", {});
      toast("Reminder snoozed until tomorrow");
    }
    if (action === "profile-skip") {
      await api("/api/profile/skip", { dimension: button.dataset.id });
      ui.dimension = null;
      toast("Skipped. You can return anytime.");
    }
    if (action === "profile-retry") {
      await api(`/api/profile/jobs/${button.dataset.id}/retry`, {});
      toast("Reply retry started");
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
      await api("/api/channel/conversations/profile/messages", {
        requestId: ui.requestId,
        dimension,
        text: form.elements.text.value,
      });
      delete ui.drafts["answer-" + dimension];
      ui.dimension = null;
      ui.requestId = null;
      toast("Answer saved; preparing a reply");
    } else {
      const facts = Object.fromEntries(new FormData(form));
      await api("/api/profile/facts", { facts }, "PATCH");
      ui.drafts = {};
      ui.dimension = null;
      toast("Shared context updated");
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

const profileStream = new EventSource(
  "/api/channel/conversations/profile/stream" +
    (sessionStorage.getItem("channelCursor:profile")
      ? "?cursor=" +
        encodeURIComponent(sessionStorage.getItem("channelCursor:profile"))
      : ""),
);
for (const kind of ["change", "snapshot"])
  profileStream.addEventListener(kind, async (event) => {
    await refresh();
    if (connected && event.lastEventId)
      sessionStorage.setItem("channelCursor:profile", event.lastEventId);
  });
