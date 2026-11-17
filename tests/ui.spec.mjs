import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
test("Chinese workspace supports demo, persistent reply routing, task lifecycle, followup and webhook example", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "体验离线演示" }).click();
  await expect(
    page.getByRole("heading", { name: "Pi 发布动态", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("已建立初始基线，不发送通知", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "模拟一次资料变化" }).click();
  await expect(
    page.getByRole("button").filter({ hasText: "Pi 发布动态 有新变化" }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("status")).toBeHidden({ timeout: 7000 });
  mkdirSync("docs/screenshots", { recursive: true });
  await page.screenshot({
    path: "docs/screenshots/overview.png",
    fullPage: true,
  });
  await page
    .getByRole("button")
    .filter({ hasText: "Pi 发布动态 有新变化" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("继续追问这次变化").fill("升级前应验证什么？");
  await page.getByRole("button", { name: "发送 ↗" }).click();
  await expect(
    page.getByRole("dialog").getByText(/第 2 条用户消息/),
  ).toBeVisible();
  await page.getByLabel("安排后续分析").fill("继续研究迁移步骤");
  await page.getByRole("button", { name: "安排跟进" }).click();
  await expect(page.getByRole("status")).toContainText("后续分析已安排");
  await expect(page.getByRole("status")).toBeHidden({ timeout: 7000 });
  await page.getByRole("dialog").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: "docs/screenshots/research-thread.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "关闭", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByLabel("任务名称").fill("公开文档监控");
  await page.getByLabel("公开资料 URL").fill("https://example.com");
  await page.getByLabel("研究目标").fill("关注文档的重要变化");
  await page.getByRole("button", { name: "保存任务" }).click();
  await expect(
    page.getByRole("heading", { name: "公开文档监控", exact: true }),
  ).toBeVisible();
  const task = page.locator(".task").filter({
    has: page.getByRole("heading", { name: "公开文档监控", exact: true }),
  });
  await task.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(task.getByText("已暂停", { exact: true })).toBeVisible();
  await task.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(task.getByText("监控中", { exact: true })).toBeVisible();
  await task.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("任务名称").fill("公开文档监控（已编辑）");
  await page.getByRole("button", { name: "保存任务" }).click();
  await expect(
    page.getByRole("heading", { name: "公开文档监控（已编辑）" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "事件与 Webhook" }).click();
  await expect(page.locator("#webhook-example")).toContainText("events:$TOKEN");
  await page.getByRole("button", { name: "模型设置" }).click();
  await page.getByLabel("API Key", { exact: true }).fill("ui-test-key");
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByRole("button", { name: "模型设置" }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "关闭", exact: true })
    .filter({ visible: true })
    .click();
  expect(errors).toEqual([]);
});
test("mobile overview has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "工作概览", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "docs/screenshots/mobile.png",
    fullPage: true,
  });
});
