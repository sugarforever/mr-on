import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
const screenshotDir = process.env.CI
  ? "test-results/screenshots"
  : "docs/screenshots";
mkdirSync(screenshotDir, { recursive: true });
test("English workspace supports demo, persistent reply routing, task lifecycle, followup and webhook example", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-GB");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try the offline demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Pi releases", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Initial baseline established; no notification sent", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Simulate a source change" }).click();
  await expect(
    page.getByRole("button").filter({ hasText: "Pi releases has new changes" }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("status")).toBeHidden({ timeout: 7000 });
  await page.screenshot({
    path: `${screenshotDir}/overview.png`,
    fullPage: true,
  });
  await page
    .getByRole("button")
    .filter({ hasText: "Pi releases has new changes" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByLabel("Ask about this change")
    .fill("What should we validate before upgrading?");
  await page.getByRole("button", { name: "Send ↗" }).click();
  await expect(
    page.getByRole("dialog").getByText(/user message 2/),
  ).toBeVisible();
  await page
    .getByLabel("Schedule follow-up analysis")
    .fill("Investigate migration steps");
  await page.getByRole("button", { name: "Schedule follow-up" }).click();
  await expect(page.getByRole("status")).toContainText("Follow-up scheduled");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 7000 });
  await page.getByRole("dialog").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: `${screenshotDir}/research-thread.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "Create monitor" }).click();
  await page.getByLabel("Monitor name").fill("Public documentation");
  await page.getByLabel("Public source URL").fill("https://example.com");
  await page
    .getByLabel("Research goal")
    .fill("Watch for important documentation changes");
  await page.getByRole("button", { name: "Save monitor" }).click();
  await expect(
    page.getByRole("heading", { name: "Public documentation", exact: true }),
  ).toBeVisible();
  const task = page.locator(".task").filter({
    has: page.getByRole("heading", {
      name: "Public documentation",
      exact: true,
    }),
  });
  await task.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(task.getByText("Paused", { exact: true })).toBeVisible();
  await task.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(task.getByText("Monitoring", { exact: true })).toBeVisible();
  await task.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Monitor name").fill("Public documentation (edited)");
  await page.getByRole("button", { name: "Save monitor" }).click();
  await expect(
    page.getByRole("heading", { name: "Public documentation (edited)" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Events & Webhook" }).click();
  await expect(page.locator("#webhook-example")).toContainText("events:$TOKEN");
  await page.getByRole("button", { name: "Model settings" }).click();
  await page.getByLabel("API Key", { exact: true }).fill("ui-test-key");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByRole("button", { name: "Model settings" }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "Close", exact: true })
    .filter({ visible: true })
    .click();
  expect(errors).toEqual([]);
});
test("mobile overview has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: `${screenshotDir}/mobile.png`,
    fullPage: true,
  });
});
test("proactive invitation opens a two-mode profile with editable memory and durable chat", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start a conversation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "About me", exact: true }),
  ).toBeVisible();
  const answer = page.getByLabel("Your answer · Name and background");
  await answer.fill("Call me Lin. I build open-source tools.");
  await page.getByRole("button", { name: "Refresh data" }).click();
  await expect(answer).toHaveValue("Call me Lin. I build open-source tools.");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(page.locator(".profile-transcript")).toContainText(
    "Thank you for sharing",
  );
  await expect(
    page.locator(".profile-fact").filter({
      has: page.getByRole("heading", {
        name: "Name and background",
        exact: true,
      }),
    }),
  ).toContainText("Call me Lin");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 7000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${screenshotDir}/profile-chat.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await expect(
    page.getByLabel("Your answer · Long-term interests"),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Fill in a form" }).click();
  await page
    .getByLabel("Communication preferences", { exact: false })
    .fill("English, direct, with the conclusion first.");
  await page.getByRole("button", { name: "Save my answers" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Shared context updated",
  );
  await page
    .getByRole("button", { name: "Disable invitations", exact: true })
    .click();
  await expect(
    page
      .locator(".profile-controls")
      .getByText("Invitations disabled", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "About me", exact: true }).click();
  await expect(page.locator(".profile-facts")).toContainText(
    "English, direct, with the conclusion first.",
  );
  await expect(page.getByRole("status")).toBeHidden({ timeout: 7000 });
  await page.screenshot({
    path: `${screenshotDir}/profile.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Delete profile and conversations" })
    .click();
  await page
    .getByRole("button", { name: "Confirm deletion", exact: true })
    .click();
  await expect(page.locator(".profile-facts")).not.toContainText("Call me Lin");
  await expect(
    page
      .locator(".profile-controls")
      .getByText("Invitations disabled", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("Gateway status becomes unknown on connection loss and recovers", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#service-label")).toHaveText(
    /Background service running|Processing events/,
  );
  await expect(page.locator("#service-detail")).toContainText("Heartbeat");
  await page.route("**/api/state", (route) => route.abort());
  await expect(page.locator("#service-label")).toHaveText(
    "Disconnected · Status unknown",
  );
  await page.locator('.nav[data-view="tasks"]').click();
  await expect(page.locator("#service-label")).toHaveText(
    "Disconnected · Status unknown",
  );
  await page.unroute("**/api/state");
  await expect(page.locator("#service-label")).toHaveText(
    /Background service running|Processing events/,
  );
});

test("Channel retry after lost acceptance is deduplicated and committed history reopens", async ({
  page,
}) => {
  await page.goto("/");
  const state = await (await page.request.get("/api/state")).json();
  const item = state.items[0];
  expect(item).toBeTruthy();
  await page
    .getByRole("button")
    .filter({ hasText: "Pi releases has new changes" })
    .first()
    .click();
  const question = "A unique question after reconnecting";
  await page.getByLabel("Ask about this change").fill(question);
  let lost = true;
  const requests = [];
  await page.route(
    "**/api/channel/conversations/**/messages",
    async (route) => {
      requests.push(route.request().postDataJSON());
      const response = await route.fetch();
      if (lost) {
        lost = false;
        await route.abort();
      } else await route.fulfill({ response });
    },
  );
  await page.getByRole("button", { name: "Send ↗" }).click();
  await expect(page.getByRole("status")).toHaveClass("error");
  await page.getByRole("button", { name: "Send ↗" }).click();
  await expect(page.getByLabel("Ask about this change")).toHaveValue("");
  expect(requests.length).toBe(2);
  expect(requests[0].requestId).toBe(requests[1].requestId);
  await page.reload();
  await page
    .getByRole("button")
    .filter({ hasText: "Pi releases has new changes" })
    .first()
    .click();
  await expect(
    page.locator("#item-content .message.user").filter({ hasText: question }),
  ).toHaveCount(1);
  await expect(page.locator("#item-content .message.assistant")).toHaveCount(
    state.messages.filter((m) => m.itemId === item.id && m.role === "assistant")
      .length + 1,
  );
});
