import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const domains = [
  { label: 'Today', href: '/' },
  { label: 'Business', href: '/business' },
  { label: 'Sales', href: '/sales' },
  { label: 'Products', href: '/catalog' },
  { label: 'Inventory', href: '/inventory' },
  { label: 'Finance', href: '/finance' },
  { label: 'Advertising', href: '/ads' },
  { label: 'Trajectory', href: '/trajectory' },
  { label: 'Data Health', href: '/data-health' },
  { label: 'Admin', href: '/admin' },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readDomains(page) {
  return page.locator('.nav-primary-set a.domain-link').evaluateAll((links) =>
    links.map((link) => ({
      label: link.textContent.trim(),
      href: new URL(link.href).pathname,
      current: link.getAttribute('aria-current'),
    })),
  );
}

async function assertDomainContract(page, activeLabel) {
  const actual = await readDomains(page);
  assert(
    JSON.stringify(actual.map(({ label, href }) => ({ label, href }))) ===
      JSON.stringify(domains),
    `domain navigation differs: ${JSON.stringify(actual)}`,
  );
  const current = actual.filter(({ current }) => current === 'page');
  assert(current.length === 1, `expected one aria-current domain: ${JSON.stringify(current)}`);
  assert(current[0].label === activeLabel, `active domain ${current[0].label} != ${activeLabel}`);
  assert(
    actual.find(({ label }) => label === 'Products')?.href === '/catalog',
    'Products must map to /catalog',
  );
  assert((await page.locator('.nav-more').count()) === 0, 'obsolete More navigation is present');
}

async function assertNoDocumentOverflow(page, label) {
  await page.evaluate(
    () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const viewportWidth = root.clientWidth;
    const documentWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0);
    return { viewportWidth, documentWidth, overflow: documentWidth - viewportWidth };
  });
  assert(
    geometry.overflow <= 1,
    `${label} overflows the mobile document: ${JSON.stringify(geometry)}`,
  );
  return { label, ...geometry };
}

const cases = [
  { name: 'business-desktop', url: '/business', width: 1600, height: 1000, active: 'Business' },
  {
    name: 'today-mobile',
    url: '/today',
    width: 390,
    height: 844,
    active: 'Today',
  },
  {
    name: 'product-mobile',
    url: '/product?sku=PNC-001',
    width: 393,
    height: 852,
    active: 'Products',
    drawerDestination: { label: 'Products', href: '/catalog' },
  },
];

const browser = await chromium.launch({ headless: true });
const results = [];

for (const testCase of cases) {
  const mobile = testCase.width <= 900;
  const context = await browser.newContext({
    viewport: { width: testCase.width, height: testCase.height },
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await context.newPage();
  const errors = [];
  const overflowChecks = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  try {
    const response = await page.goto(baseUrl + testCase.url, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    assert(response?.ok(), `navigation failed with ${response?.status()}`);
    await page.locator('#app-sidebar .primary-nav.app-navigation').waitFor({ timeout: 5_000 });
    await assertDomainContract(page, testCase.active);
    if (mobile)
      overflowChecks.push(await assertNoDocumentOverflow(page, `${testCase.name} direct load`));

    const brandHref = await page.locator('.shell-global-header a.brand').getAttribute('href');
    assert(brandHref === '/', `brand link ${brandHref} != /`);

    const sidebar = page.locator('#app-sidebar');
    const menuButton = page.locator('.shell-menu-button');
    if (!mobile) {
      assert(await sidebar.isVisible(), 'desktop navigation is not visible');
      assert((await sidebar.getAttribute('aria-hidden')) === 'false', 'desktop navigation is hidden');
      assert(!(await sidebar.getAttribute('inert')), 'desktop navigation is inert');
      assert(!(await menuButton.isVisible()), 'mobile menu button is visible on desktop');

      const navBox = await page.locator('#app-navigation').boundingBox();
      const headerBox = await page.locator('.shell-global-header').boundingBox();
      const sidebarBox = await sidebar.boundingBox();
      assert(navBox && headerBox, 'desktop shell geometry is unavailable');
      assert(
        sidebarBox && sidebarBox.x === 0 && Math.abs(sidebarBox.width - 244) <= 1,
        'desktop sidebar is not anchored to the left edge',
      );
      assert(headerBox.x >= 244, 'desktop header overlaps the sidebar');
      assert(navBox.height > 400, 'desktop domain navigation is not vertical');
      assert(await page.locator('.app-sidebar__header').isVisible(), 'sidebar header is missing on desktop');
      assert(await page.locator('.app-sidebar__footer').isVisible(), 'sidebar footer is missing on desktop');
    } else {
      assert(await menuButton.isVisible(), 'mobile navigation trigger is not visible');
      assert(
        (await page.locator('.shell-header-context__title').textContent())?.trim() === testCase.active,
        'mobile header does not expose the active destination',
      );
      assert((await menuButton.getAttribute('aria-expanded')) === 'false', 'drawer starts expanded');
      assert((await sidebar.getAttribute('aria-hidden')) === 'true', 'closed drawer is exposed');
      assert((await sidebar.getAttribute('inert')) !== null, 'closed drawer is not inert');

      await menuButton.click();
      await page.locator('body.shell-drawer-open').waitFor({ timeout: 2_000 });
      assert((await menuButton.getAttribute('aria-expanded')) === 'true', 'drawer state is not exposed');
      assert((await sidebar.getAttribute('aria-hidden')) === 'false', 'open drawer remains hidden');
      assert((await sidebar.getAttribute('inert')) === null, 'open drawer remains inert');
      assert(
        await page
          .locator('.shell-drawer-close')
          .evaluate((element) => element === document.activeElement),
        'drawer focus did not move inside',
      );

      if (testCase.drawerDestination) {
        const destination = sidebar.getByRole('link', {
          name: testCase.drawerDestination.label,
          exact: true,
        });
        await Promise.all([
          page.waitForURL(url => url.pathname === testCase.drawerDestination.href, {
            timeout: 10_000,
          }),
          destination.click(),
        ]);
        await page.locator('#app-sidebar .primary-nav.app-navigation').waitFor({ timeout: 5_000 });
        await assertDomainContract(page, testCase.drawerDestination.label);
        overflowChecks.push(
          await assertNoDocumentOverflow(
            page,
            `${testCase.name} drawer navigation to ${testCase.drawerDestination.href}`,
          ),
        );
      } else {
        await page.keyboard.press('Escape');
        await page.locator('body:not(.shell-drawer-open)').waitFor({ timeout: 2_000 });
        assert((await menuButton.getAttribute('aria-expanded')) === 'false', 'Escape did not close drawer');
        assert(
          await menuButton.evaluate((element) => element === document.activeElement),
          'drawer focus did not return to its trigger',
        );
      }
    }

    await page.screenshot({
      path: path.join(outDir, `nav-${testCase.name}.png`),
      fullPage: false,
    });
  } catch (error) {
    errors.push(error.message);
  }

  results.push({ ...testCase, overflowChecks, errors, ok: errors.length === 0 });
  await context.close();
}

await browser.close();
await fs.writeFile(
  path.join(outDir, 'nav-summary.json'),
  JSON.stringify({ baseUrl, domains, results }, null, 2),
);
console.log(
  JSON.stringify(
    { navigationQA: results.map(({ name, ok, errors }) => ({ name, ok, errors })) },
    null,
    2,
  ),
);
if (results.some(({ ok }) => !ok)) process.exitCode = 3;
