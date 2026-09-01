import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const routes = [
  "/",
  "/today",
  "/business",
  "/sales",
  "/catalog",
  "/inventory",
  "/finance",
  "/trajectory",
  "/ads",
  "/data-health",
  "/admin",
  "/product?sku=PNC-001",
];

const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
];

const browser = await chromium.launch({ headless: true });
const results = [];

for (const viewport of viewports) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  for (const route of routes) {
    const errors = [];
    try {
      const response = await page.goto(baseUrl + route, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      if (!response?.ok())
        throw new Error(`navigation ${response?.status() || "failed"}`);
      const footer = page.locator(".app > footer.footer");
      await footer.waitFor({ state: "visible", timeout: 5000 });
      const state = await footer.evaluate((node) => {
        const details = node.querySelector(".footer-diagnostics");
        const summary = details?.querySelector(":scope > summary");
        const rect = node.getBoundingClientRect();
        const summaryRect = summary?.getBoundingClientRect();
        return {
          count: document.querySelectorAll("footer.footer").length,
          label: node.getAttribute("aria-label"),
          detailsCount: node.querySelectorAll(".footer-diagnostics").length,
          open: details?.open,
          summary: summary?.textContent?.trim(),
          visibleText: node.innerText.replace(/\s+/g, " ").trim(),
          summaryHeight: summaryRect?.height || 0,
          contained: rect.left >= -2 && rect.right <= window.innerWidth + 2,
          pageContained:
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 2,
          textTransform: getComputedStyle(node).textTransform,
        };
      });
      if (state.count !== 1)
        errors.push(`expected one shared footer, found ${state.count}`);
      if (state.label !== "Build diagnostics")
        errors.push(`invalid footer label: ${JSON.stringify(state.label)}`);
      if (state.detailsCount !== 1 || state.open)
        errors.push("footer disclosure must be singular and collapsed");
      if (
        state.summary !== "Build info" ||
        state.visibleText !== "Build info"
      ) {
        errors.push(
          `footer is not subordinate when collapsed: ${JSON.stringify(state.visibleText)}`,
        );
      }
      if (state.summaryHeight < 40)
        errors.push(`footer summary target is ${state.summaryHeight}px tall`);
      if (!state.contained || !state.pageContained)
        errors.push("footer creates horizontal overflow");
      if (state.textTransform !== "none")
        errors.push(`footer text transform is ${state.textTransform}`);

      const buildMeta = await page
        .locator('meta[name="dpp-build-revision"]')
        .getAttribute("content");
      const assetMeta = await page
        .locator('meta[name="dpp-asset-revision"]')
        .getAttribute("content");
      if (!/^(?:dev|[0-9a-f]{8})$/i.test(buildMeta || "")) {
        errors.push(`invalid build metadata: ${JSON.stringify(buildMeta)}`);
      }
      if (!/^[0-9a-f]{12}$/i.test(assetMeta || "")) {
        errors.push(`invalid asset metadata: ${JSON.stringify(assetMeta)}`);
      }

      const build = footer.locator(".footer-build");
      const assets = footer.locator(".footer-assets");
      if ((await build.isVisible()) || (await assets.isVisible()))
        errors.push("diagnostics visible before disclosure");
      await footer.locator("summary").click();
      const buildText = ((await build.textContent()) || "").trim();
      const assetText = ((await assets.textContent()) || "").trim();
      if (
        !(await build.isVisible()) ||
        !new RegExp(`^main ${buildMeta}$`, "i").test(buildText)
      ) {
        errors.push(
          `invalid disclosed build stamp: ${JSON.stringify(buildText)}`,
        );
      }
      if (
        !(await assets.isVisible()) ||
        !new RegExp(`^assets ${assetMeta}$`, "i").test(assetText)
      ) {
        errors.push(
          `invalid disclosed asset stamp: ${JSON.stringify(assetText)}`,
        );
      }
      await footer.locator("summary").click();
    } catch (error) {
      errors.push(error.message);
    }
    results.push({
      viewport: viewport.name,
      route,
      ok: errors.length === 0,
      errors,
    });
  }
  await context.close();
}

await browser.close();
await fs.writeFile(
  path.join(outDir, "footer-summary.json"),
  JSON.stringify({ baseUrl, results }, null, 2),
);
console.log(JSON.stringify({ footerQA: results }, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 4;
