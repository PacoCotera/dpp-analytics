import { chromium, webkit } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const baseOrigin = new URL(baseUrl).origin;
const engines = [
  ['chromium', chromium],
  ['webkit', webkit],
];
const inventoryViewports = [
  [999, 915],
  [1000, 915],
  [1001, 915],
  [1179, 915],
  [1180, 915],
  [1181, 915],
  [1440, 900],
  [1920, 1080],
  [360, 800],
  [412, 915],
];
const geographyViewports = [
  [390, 664],
  [393, 727],
  [719, 915],
  [720, 915],
  [721, 915],
];
const modalViewports = [
  [1440, 900],
  [390, 800],
];

const summary = {
  ok: false,
  inventory: [],
  geography: [],
  modal: [],
};

function monitor(page, label) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`${label} pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${label} console: ${message.text()}`);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === baseOrigin && response.status() >= 400) {
      errors.push(`${label} response ${response.status()}: ${url.pathname}${url.search}`);
    }
  });
  return errors;
}
function assertClean(errors) {
  if (errors.length) throw new Error(errors.join(' | '));
}

async function verifyInventory(browser, engine, width, height) {
  const label = `${engine} inventory ${width}x${height}`;
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = monitor(page, label);
  try {
    const response = await page.goto(`${baseUrl}/inventory`, { waitUntil: 'networkidle', timeout: 30000 });
    if (!response?.ok()) throw new Error(`${label} navigation returned ${response?.status() || 'no response'}`);
    await page.locator('.inventory-page-header').waitFor({ state: 'visible', timeout: 10000 });
    const geometry = await page.evaluate(() => {
      const header = document.querySelector('.inventory-page-header');
      const how = document.getElementById('howBtn');
      const kpis = [...document.querySelectorAll('.inventory-page-header .kpi')];
      if (!header || !how || kpis.length !== 4) return null;
      const headerRect = header.getBoundingClientRect();
      const contained = (element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= headerRect.left - 1 &&
          rect.right <= headerRect.right + 1 &&
          rect.top >= headerRect.top - 1 &&
          rect.bottom <= headerRect.bottom + 1
        );
      };
      return {
        headerClientWidth: header.clientWidth,
        headerScrollWidth: header.scrollWidth,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        kpisContained: kpis.map(contained),
        howContained: contained(how),
        inboundVisible: contained(document.getElementById('inbound')),
        columns: getComputedStyle(header).gridTemplateColumns,
      };
    });
    if (!geometry) throw new Error(`${label} lead geometry is unavailable`);
    if (geometry.headerScrollWidth > geometry.headerClientWidth + 1) {
      throw new Error(`${label} lead overflows internally: ${JSON.stringify(geometry)}`);
    }
    if (geometry.documentOverflow > 1) throw new Error(`${label} document overflow: ${JSON.stringify(geometry)}`);
    if (!geometry.kpisContained.every(Boolean) || !geometry.inboundVisible || !geometry.howContained) {
      throw new Error(`${label} hides lead content: ${JSON.stringify(geometry)}`);
    }
    assertClean(errors);
    summary.inventory.push({ engine, width, height, ...geometry });
  } finally {
    await page.close();
  }
}

async function verifyGeography(browser, engine, width, height) {
  const label = `${engine} geography ${width}x${height}`;
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = monitor(page, label);
  try {
    const response = await page.goto(`${baseUrl}/sales?view=geography`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    if (!response?.ok()) throw new Error(`${label} navigation returned ${response?.status() || 'no response'}`);
    await page.locator('#geography.view.active').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#geoRankedRows tr').first().waitFor({ state: 'visible', timeout: 20000 });
    const geometry = await page.evaluate(() => {
      const table = document.querySelector('.geo-table');
      const body = table?.querySelector('tbody');
      const firstRow = body?.querySelector('tr');
      if (!table || !body || !firstRow) return null;
      const tableRect = table.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const rowRect = firstRow.getBoundingClientRect();
      const labels = [...body.querySelectorAll('.geo-area-cell strong')].map((element) => ({
        text: element.textContent?.trim() || '',
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      return {
        tableWidth: tableRect.width,
        bodyWidth: bodyRect.width,
        rowWidth: rowRect.width,
        tableDisplay: getComputedStyle(table).display,
        bodyDisplay: getComputedStyle(body).display,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clippedLabels: labels.filter((item) => item.scrollWidth > item.clientWidth + 1),
      };
    });
    if (!geometry) throw new Error(`${label} table geometry is unavailable`);
    if (width <= 720 && geometry.tableDisplay !== 'block') {
      throw new Error(
        `${label} leaves the mobile table in its shrink-to-fit table formatting context: ${JSON.stringify(geometry)}`,
      );
    }
    if (geometry.bodyWidth < geometry.tableWidth * 0.97 || geometry.rowWidth < geometry.tableWidth * 0.97) {
      throw new Error(`${label} result cards do not own the table width: ${JSON.stringify(geometry)}`);
    }
    if (geometry.documentOverflow > 1) throw new Error(`${label} document overflow: ${JSON.stringify(geometry)}`);
    if (geometry.clippedLabels.length) throw new Error(`${label} clips state labels: ${JSON.stringify(geometry.clippedLabels)}`);
    assertClean(errors);
    summary.geography.push({ engine, width, height, ...geometry, clippedLabels: [] });
  } finally {
    await page.close();
  }
}

async function verifyModal(browser, engine, width, height) {
  const label = `${engine} modal ${width}x${height}`;
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = monitor(page, label);
  try {
    const response = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle', timeout: 30000 });
    if (!response?.ok()) throw new Error(`${label} navigation returned ${response?.status() || 'no response'}`);
    const trigger = page.locator('.rule-trigger').first();
    await trigger.waitFor({ state: 'visible', timeout: 15000 });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('#interpretationRuleDialog[open]');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });

    const closeButton = page.getByRole('button', { name: 'Close rule detail' });
    if (!(await closeButton.evaluate((element) => element === document.activeElement))) {
      throw new Error(`${label} did not focus Close on keyboard entry`);
    }

    await page.keyboard.press('Tab');
    if (!(await dialog.evaluate((element) => element.contains(document.activeElement)))) {
      throw new Error(`${label} let Tab escape the dialog`);
    }
    await page.keyboard.press('Shift+Tab');
    if (!(await dialog.evaluate((element) => element.contains(document.activeElement)))) {
      throw new Error(`${label} let Shift+Tab escape the dialog`);
    }

    await dialog.evaluate((element) => {
      const button = document.createElement('button');
      button.id = 'auditBatch1DynamicFocus';
      button.type = 'button';
      button.textContent = 'Dynamic focus target';
      element.querySelector('.rule-dialog__body')?.append(button);
    });
    await closeButton.focus();
    await page.keyboard.press('Tab');
    const dynamicFocused = await page.locator('#auditBatch1DynamicFocus').evaluate((element) => element === document.activeElement);
    if (!dynamicFocused) throw new Error(`${label} did not include dynamic focusable content in the cycle`);
    await page.keyboard.press('Tab');
    if (!(await closeButton.evaluate((element) => element === document.activeElement))) {
      throw new Error(`${label} did not wrap focus to the first control`);
    }
    await page.keyboard.press('Shift+Tab');
    if (!(await page.locator('#auditBatch1DynamicFocus').evaluate((element) => element === document.activeElement))) {
      throw new Error(`${label} did not reverse-wrap focus to the last control`);
    }

    await trigger.evaluate((element) => element.replaceWith(element.cloneNode(true)));

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(
      () => document.activeElement?.matches('.rule-trigger[data-rule-for="dayHeadline"]'),
      null,
      { timeout: 1000 },
    );
    if (!(await trigger.evaluate((element) => element === document.activeElement))) {
      throw new Error(`${label} Escape did not restore the invoking trigger`);
    }

    await page.evaluate(async () => {
      const trigger = document.activeElement;
      const target = document.getElementById(trigger.dataset.ruleFor);
      const evaluation = JSON.parse(trigger.dataset.ruleEvaluation || '{}');
      const pageModuleUrl = [...document.scripts]
        .map((script) => script.src)
        .find((url) => url.includes('/today.js'));
      if (!target || !evaluation.rule_id || !pageModuleUrl) {
        throw new Error('Rule trigger remount inputs are unavailable');
      }
      const moduleUrl = new URL('./ui-utils.js', pageModuleUrl).href;
      const { mountRuleTrigger } = await import(moduleUrl);
      mountRuleTrigger(target, evaluation, { [evaluation.rule_id]: {} });
    });
    if (!(await trigger.evaluate((element) => element === document.activeElement))) {
      throw new Error(`${label} live remount did not preserve focus on the invoking trigger`);
    }

    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('button', { name: 'Close rule detail' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    await page.waitForFunction(
      () => document.activeElement?.matches('.rule-trigger[data-rule-for="dayHeadline"]'),
      null,
      { timeout: 1000 },
    );
    if (!(await trigger.evaluate((element) => element === document.activeElement))) {
      throw new Error(`${label} Close did not restore the invoking trigger`);
    }
    if (await page.evaluate(() => document.activeElement === document.body)) {
      throw new Error(`${label} left focus on BODY`);
    }
    assertClean(errors);
    summary.modal.push({ engine, width, height, focusContained: true, escapeReturn: true, closeReturn: true });
  } finally {
    await page.close();
  }
}

try {
  for (const [engine, browserType] of engines) {
    const browser = await browserType.launch({ headless: true });
    try {
      for (const [width, height] of inventoryViewports) await verifyInventory(browser, engine, width, height);
      for (const [width, height] of geographyViewports) await verifyGeography(browser, engine, width, height);
      for (const [width, height] of modalViewports) await verifyModal(browser, engine, width, height);
    } finally {
      await browser.close();
    }
  }
  summary.ok = true;
  await fs.writeFile(path.join(outDir, 'audit-batch1-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = error.message;
  await fs.writeFile(path.join(outDir, 'audit-batch1-summary.json'), JSON.stringify(summary, null, 2));
  console.error(error);
  process.exitCode = 1;
}
