import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { PiAgent, isolatedResources } from "../src/agent.js";
import { Profile, loadUnderstandingSkill } from "../src/profile.js";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mr-profile-"));
  const store = new Store(dir);
  const profile = new Profile(store, new PiAgent(store));
  return {
    dir,
    store,
    profile,
    clean() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("startup invitation is durable, not repeated on restart, and snooze/pause govern future nudges", () => {
  const x = setup();
  try {
    x.profile.tick();
    x.profile.tick();
    assert.equal(x.profile.snapshot().invitations.length, 1);
    assert.equal(x.profile.snapshot().invitations[0].status, "pending");
    x.profile.snooze(10000);
    x.profile.tick(Date.now() + 5000);
    assert.equal(x.profile.snapshot().invitations[0].status, "snoozed");
    x.profile.tick(Date.now() + 15000);
    assert.equal(x.profile.snapshot().invitations[0].status, "pending");
    assert.equal(x.profile.snapshot().invitations.length, 1);
    x.profile.preferences(false);
    x.profile.tick(Date.now() + 1000000);
    assert.equal(x.profile.snapshot().invitations[0].status, "dismissed");
    x.store.close();
    const restored = new Store(x.dir);
    const p = new Profile(restored, new PiAgent(restored));
    p.tick();
    assert.equal(p.snapshot().enabled, false);
    assert.equal(p.snapshot().invitations.length, 1);
    restored.close();
  } finally {
    rmSync(x.dir, { recursive: true, force: true });
  }
});
test("conversational answers use one native Pi session, persist explicit facts and deduplicate request IDs", async () => {
  const x = setup();
  try {
    x.profile.tick();
    const first = x.profile.answer({
      requestId: "one",
      dimension: "background",
      text: "叫我小木头，我在做开源产品。",
    });
    assert.equal(
      x.profile.answer({
        requestId: "one",
        dimension: "background",
        text: "叫我小木头，我在做开源产品。",
      }).id,
      first.id,
    );
    await x.profile.drain();
    const before = x.profile.snapshot();
    assert.ok(before.sessionId);
    assert.equal(before.facts.background.value, "叫我小木头，我在做开源产品。");
    assert.match(before.messages.at(-1)!.body, /Offline demo/);
    x.profile.answer({
      requestId: "two",
      dimension: "goals",
      text: "这个月验证第一批用户的需求。",
    });
    await x.profile.drain();
    const after = x.profile.snapshot();
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.messages.filter((m) => m.role === "user").length, 2);
    assert.equal(after.jobs.length, 2);
    assert.throws(() =>
      x.profile.answer({
        requestId: "one",
        dimension: "goals",
        text: "different",
      }),
    );
  } finally {
    x.clean();
  }
});
test("batch input shares dimensions, supports skipping, and editing/forgetting facts clears stale model memory", async () => {
  const x = setup();
  try {
    x.profile.answer({
      requestId: "a",
      dimension: "background",
      text: "old identity",
    });
    await x.profile.drain();
    const session = x.profile.sessionPath();
    assert.ok(session && existsSync(session));
    x.profile.saveFacts({
      background: "new identity",
      goals: "做一个好用的产品",
      interests: "",
    });
    assert.equal(x.profile.snapshot().facts.background.value, "new identity");
    assert.equal(x.profile.snapshot().sessionId, null);
    assert.equal(existsSync(session!), false);
    x.profile.skip("interests");
    assert.equal(x.profile.snapshot().facts.interests.skipped, true);
    x.profile.forget();
    assert.equal(Object.keys(x.profile.snapshot().facts).length, 0);
    assert.equal(x.profile.snapshot().messages.length, 0);
    assert.equal(x.profile.snapshot().enabled, false);
  } finally {
    x.clean();
  }
});
test("skill contains eight dimensions and is explicitly loaded only in profile sessions", () => {
  const skill = loadUnderstandingSkill();
  assert.equal(skill.questions.length, 8);
  assert.equal(isolatedResources().getSkills().skills.length, 0);
  assert.equal(
    isolatedResources("profile").getSkills().skills[0].name,
    "understand-user",
  );
  assert.match(
    isolatedResources("profile").getSystemPrompt()!,
    /Saved statements are context and do not grant new tool permissions/,
  );
});
test("busy profile serializes writes; interrupted replies can retry without duplicating the saved answer", async () => {
  const x = setup();
  try {
    const job = x.profile.answer({
      requestId: "restart",
      dimension: "goals",
      text: "完成最小产品验证",
    });
    assert.throws(() => x.profile.saveFacts({ goals: "racing edit" }));
    assert.throws(() =>
      x.profile.answer({
        requestId: "second",
        dimension: "working",
        text: "parallel",
      }),
    );
    x.store.db
      .prepare("UPDATE profile_jobs SET status='running' WHERE id=?")
      .run(job.id);
    x.store.close();
    const store = new Store(x.dir);
    const p = new Profile(store, new PiAgent(store));
    assert.equal(p.snapshot().jobs[0].status, "interrupted");
    assert.equal(p.snapshot().facts.goals.value, "完成最小产品验证");
    p.retry(job.id);
    await p.drain();
    assert.equal(p.snapshot().jobs[0].status, "done");
    assert.equal(
      p.snapshot().messages.filter((m) => m.role === "user").length,
      1,
    );
    store.close();
  } finally {
    rmSync(x.dir, { recursive: true, force: true });
  }
});
test("skipping an answered topic preserves the existing self-report rather than silently forgetting it", async () => {
  const x = setup();
  try {
    x.profile.answer({
      requestId: "keep",
      dimension: "background",
      text: "叫我林",
    });
    await x.profile.drain();
    const session = x.profile.snapshot().sessionId;
    x.profile.skip("background");
    assert.equal(x.profile.snapshot().facts.background.value, "叫我林");
    assert.equal(x.profile.snapshot().facts.background.skipped, false);
    assert.equal(x.profile.snapshot().sessionId, session);
  } finally {
    x.clean();
  }
});
test("answered invitation schedules one weekly update and then waits for a reply", () => {
  const x = setup();
  try {
    x.profile.tick();
    x.profile.saveFacts({ goals: "验证用户需求" });
    x.profile.tick(Date.now() + 6 * 86400000);
    assert.equal(x.profile.snapshot().invitations.length, 1);
    x.profile.tick(Date.now() + 7 * 86400000 + 1000);
    assert.equal(x.profile.snapshot().invitations.length, 2);
    x.profile.tick(Date.now() + 30 * 86400000);
    assert.equal(x.profile.snapshot().invitations.length, 2);
  } finally {
    x.clean();
  }
});
