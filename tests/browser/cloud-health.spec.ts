import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const service = {
  id: "svc-1", name: "Public API", url: "https://api.example.com/health", intervalSeconds: 60,
  acceptedStatusMin: 200, acceptedStatusMax: 299, createdAt: "2026-01-01T00:00:00Z", status: "pending",
  latestCheck: null, availability24h: null, history: [],
};
const history = { range: "24h", asOf: "2026-01-01T01:00:00Z", availability: null, buckets: [], checks: [], nextCursor: null };

async function mockApi(page: Page, services = [service]) {
  await page.route("**/api/services", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: service });
    return route.fulfill({ json: { serverTime: "2026-01-01T01:00:00Z", worker: { delayed: false, lastHeartbeatAt: null }, counts: { up: 0, down: 0, pending: services.length, stale: 0 }, services } });
  });
  await page.route("**/api/services/svc-1/history?*", (route) => route.fulfill({ json: history }));
  await page.route("**/api/services/svc-1", (route) => route.request().method() === "DELETE" ? route.fulfill({ status: 204 }) : route.fulfill({ json: service }));
}

test("empty dashboard exposes the first-run create journey", async ({ page }) => {
  await mockApi(page, []);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Add your first service" })).toBeVisible();
  await page.getByRole("link", { name: /create service/i }).first().click();
  await expect(page.getByRole("heading", { name: "Create service" })).toBeVisible();
});

test("create form posts a service and lands on pending detail", async ({ page }) => {
  await mockApi(page);
  await page.goto("/services/new");
  await page.getByLabel("Service name").fill("Public API");
  await page.getByLabel("Endpoint URL").fill("https://api.example.com/health");
  await page.getByRole("button", { name: "Create service" }).click();
  await expect(page).toHaveURL(/\/services\/svc-1$/);
  await expect(page.locator(".status-badge.pending:visible").first()).toBeVisible();
});

test("pending dashboard state and detail history are available on mobile", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator(".status-badge.pending:visible").first()).toBeVisible();
  await page.getByRole("link", { name: "Public API" }).first().click();
  await expect(page.getByRole("heading", { name: "Response time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Exact checks" })).toBeVisible();
});

test("delete dialog supports keyboard cancellation and permanent deletion", async ({ page }) => {
  await mockApi(page);
  await page.goto("/services/svc-1");
  const trigger = page.getByRole("button", { name: "Delete service" });
  await trigger.focus(); await trigger.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await page.getByRole("button", { name: "Delete service" }).last().click();
  await expect(page).toHaveURL(/\/$/);
});
