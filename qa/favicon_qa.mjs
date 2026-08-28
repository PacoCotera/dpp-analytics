import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const routes = [
  "/",
  "/today",
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

const browser = await chromium.launch({ headless: true });
const results = [];
const failures = [];

try {
  for (const route of routes) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = [];

    page.on("pageerror", (error) =>
      errors.push(`page error: ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        errors.push(`console error: ${message.text()}`);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === baseUrl && response.status() >= 400) {
        errors.push(`HTTP ${response.status()}: ${url.pathname}${url.search}`);
      }
    });

    try {
      const navigation = await page.goto(`${baseUrl}${route}`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      if (!navigation?.ok())
        throw new Error(`navigation ${navigation?.status() || "failed"}`);

      const icons = page.locator('link[rel~="icon"]');
      const iconCount = await icons.count();
      if (iconCount !== 1)
        throw new Error(`expected one icon declaration, found ${iconCount}`);
      const iconUrl = await icons.first().getAttribute("href");
      if (!/^\/assets\/favicon\.svg\?v=[0-9a-f]{12}$/.test(iconUrl || "")) {
        throw new Error(
          `icon URL is not release-versioned: ${JSON.stringify(iconUrl)}`,
        );
      }

      const iconResponse = await context.request.get(
        new URL(iconUrl, baseUrl).href,
      );
      const contentType = iconResponse.headers()["content-type"] || "";
      const body = await iconResponse.text();
      if (
        iconResponse.status() !== 200 ||
        !contentType.startsWith("image/svg+xml")
      ) {
        throw new Error(
          `icon response ${iconResponse.status()} ${JSON.stringify(contentType)}`,
        );
      }
      if (!/^\s*<svg\b/.test(body))
        throw new Error("icon response is not SVG content");
    } catch (error) {
      errors.push(error.message);
    }

    const result = { route, ok: errors.length === 0, errors };
    results.push(result);
    if (!result.ok) failures.push(`${route}: ${errors.join("; ")}`);
    await context.close();
  }

  const compatibility = await fetch(`${baseUrl}/favicon.ico`, {
    cache: "no-store",
  });
  const compatibilityBody = await compatibility.text();
  const compatibilityType = compatibility.headers.get("content-type") || "";
  if (
    compatibility.status !== 200 ||
    !compatibilityType.startsWith("image/svg+xml") ||
    !/^\s*<svg\b/.test(compatibilityBody)
  ) {
    failures.push(
      `/favicon.ico: ${compatibility.status} ${JSON.stringify(compatibilityType)} is not valid SVG`,
    );
  }

  const summary = {
    ok: failures.length === 0,
    routes: results.length,
    compatibility: {
      status: compatibility.status,
      contentType: compatibilityType,
    },
    results,
    failures,
  };
  await fs.writeFile(
    path.join(outDir, "favicon-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  const summary = { ok: false, error: error.message, results, failures };
  await fs.writeFile(
    path.join(outDir, "favicon-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
