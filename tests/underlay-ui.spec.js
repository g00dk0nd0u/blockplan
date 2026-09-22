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

test("restored Underlay metadata requiring relink does not show the dock", async ({ page }) => {
  await page.goto(appUrl);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("blockplan.currentPlan.v1", JSON.stringify({
      version: 1,
      moduleSizeMm: 3600,
      categories: [],
      cells: {},
      underlay: {
        name: "missing.pdf",
        type: "pdf",
        visible: true,
        locked: true,
        opacity: 0.5,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        needsRelink: true
      }
    }));
  });
  await page.reload();

  await expect(page.getByTestId("underlay-dock")).toBeHidden();
  await expect(page.getByTestId("link-underlay")).toBeVisible();
  await expect(page.locator(".underlay-message")).toContainText("Relink required");
});

test("PDF uses a rendered page instead of native viewer chrome", async ({ page }) => {
  await page.goto(appUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const pdf = await page.pdf({ width: "4in", height: "4in" });

  await page.getByTestId("underlay-input").setInputFiles({
    name: "plan.pdf",
    mimeType: "application/pdf",
    buffer: pdf
  });

  const dock = page.getByTestId("underlay-dock");
  await expect(dock).toBeVisible();
  await expect(page.locator(".underlay-layer canvas[data-underlay-content]")).toBeVisible();
  await expect(page.locator(".underlay-layer object, .underlay-layer iframe")).toHaveCount(0);
  await expect(dock.locator("#underlayStatus")).toContainText("linked (pdf)");
});

test("hiding an Underlay invalidates an in-flight PDF render", async ({ page }) => {
  await page.goto(appUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const pdf = await page.pdf({ width: "4in", height: "4in" });
  await page.evaluate(() => {
    const pdfjsLib = window.pdfjsLib;
    const getDocument = pdfjsLib.getDocument.bind(pdfjsLib);
    const delayedGetDocument = (...args) => {
      const task = getDocument(...args);
      const promise = task.promise.then((document) => new Promise((resolve) => {
        window.releasePdfDocument = () => {
          const getPage = document.getPage.bind(document);
          document.getPage = async (...pageArgs) => {
            const pdfPage = await getPage(...pageArgs);
            const render = pdfPage.render.bind(pdfPage);
            pdfPage.render = (...renderArgs) => {
              const renderTask = render(...renderArgs);
              const renderPromise = renderTask.promise.then((result) => {
                window.pdfRenderSettled = true;
                return result;
              });
              return new Proxy(renderTask, {
                get(target, property) {
                  if (property === "promise") return renderPromise;
                  const value = target[property];
                  return typeof value === "function" ? value.bind(target) : value;
                }
              });
            };
            return pdfPage;
          };
          resolve(document);
        };
      }));
      return new Proxy(task, {
        get(target, property) {
          if (property === "promise") return promise;
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    };
    window.pdfjsLib = new Proxy(pdfjsLib, {
      get(target, property) {
        if (property === "getDocument") return delayedGetDocument;
        return target[property];
      }
    });
  });

  await page.getByTestId("underlay-input").setInputFiles({
    name: "slow-plan.pdf",
    mimeType: "application/pdf",
    buffer: pdf
  });
  await expect.poll(() => page.evaluate(() => typeof window.releasePdfDocument)).toBe("function");
  await page.evaluate(() => toggleUnderlayVisibility());
  await page.evaluate(() => window.releasePdfDocument());
  await expect.poll(() => page.evaluate(() => window.pdfRenderSettled)).toBe(true);

  await expect(page.locator(".underlay-layer canvas[data-underlay-content]")).toHaveCount(0);
  await expect(page.locator("#toggleUnderlayButton")).toHaveText("Show");
});

test("Lock and Move are explicit, dragging moves the Underlay, Escape exits, and Undo restores it", async ({ page }) => {
  await page.goto(appUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByTestId("underlay-input").setInputFiles({
    name: "underlay.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ddd"/></svg>')
  });

  const dock = page.getByTestId("underlay-dock");
  const lock = dock.locator("#lockUnderlayButton");
  const move = dock.locator("#moveUnderlayButton");
  await expect(lock).toHaveText("Locked");
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  await move.click();
  await expect(page.getByTestId("save-status")).toHaveText("Underlay locked");

  await lock.click();
  await expect(lock).toHaveText("Unlocked");
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await move.click();
  await expect(move).toHaveClass(/is-active/);
  await expect(move).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#planningCanvas")).toHaveCSS("cursor", "grab");

  await page.keyboard.press("Escape");
  await expect(move).not.toHaveClass(/is-active/);
  await move.click();
  const canvas = page.locator("#planningCanvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 35, { steps: 5 });
  await page.mouse.up();

  const moved = await page.evaluate(() => JSON.parse(localStorage.getItem("blockplan.currentPlan.v1")).underlay.transform);
  expect(moved.x).not.toBe(0);
  expect(moved.y).not.toBe(0);
  await page.keyboard.press("Control+z");
  const undone = await page.evaluate(() => JSON.parse(localStorage.getItem("blockplan.currentPlan.v1")).underlay.transform);
  expect(undone).toMatchObject({ x: 0, y: 0, scale: 1, rotation: 0 });
});
