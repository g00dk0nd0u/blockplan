const { test, expect } = require("@playwright/test");
const path = require("path");

const appUrl = `file://${path.resolve(__dirname, "../docs/index.html")}`;

test("Underlay controls stay out of the sidebar and appear only after linking", async ({ page }) => {
  await page.goto(appUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const dock = page.getByTestId("underlay-dock");
  await expect(dock).toBeHidden();
  await expect(page.locator(".right-sidebar h2").filter({ hasText: "Underlay" })).toBeHidden();

  await page.getByTestId("underlay-input").setInputFiles({
    name: "underlay.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#ddd"/></svg>')
  });

  await expect(dock).toBeVisible();
  await expect(dock.locator("#underlayStatus")).toContainText("underlay.svg linked");
  await expect(dock.locator("#replaceUnderlayButton")).toBeEnabled();
  await expect(dock.locator(".help-copy")).toBeHidden();

  await dock.locator("#toggleUnderlayButton").click();
  await expect(dock).toBeVisible();
  await expect(dock.locator("#toggleUnderlayButton")).toHaveText("Show");
});
