const byId = (id) => document.getElementById(id);

const state = {
  csrf: null,
  revision: null,
  catalog: null,
};

function text(value) {
  return String(value ?? '');
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showAuthenticated(authenticated) {
  byId('loginPanel').classList.toggle('is-hidden', authenticated);
  byId('adminPanel').classList.toggle('is-hidden', !authenticated);
  byId('logout').classList.toggle('is-hidden', !authenticated);
  if (!authenticated) byId('password').focus();
}

function field(label, name, value, options = {}) {
  const wrapper = element('label', `admin-field${options.wide ? ' admin-field-wide' : ''}`);
  wrapper.append(element('span', '', label));
  const input = document.createElement('input');
  input.name = name;
  input.value = value ?? '';
  input.type = options.type || 'text';
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.step) input.step = options.step;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  wrapper.append(input);
  return wrapper;
}

function taxonomyRow(name = '', value = '') {
  const row = element('div', 'taxonomy-row');
  const key = document.createElement('input');
  key.className = 'taxonomy-key';
  key.placeholder = 'Dimension, e.g. format';
  key.setAttribute('aria-label', 'Taxonomy dimension');
  key.value = name;
  const mapped = document.createElement('input');
  mapped.className = 'taxonomy-value';
  mapped.placeholder = 'Seller-facing value';
  mapped.setAttribute('aria-label', 'Mapped taxonomy value');
  mapped.value = value;
  const remove = element('button', 'taxonomy-remove', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${name || 'taxonomy'} field`);
  remove.addEventListener('click', () => row.remove());
  row.append(key, mapped, remove);
  return row;
}

function sourceEvidence(product) {
  const evidence = element('div', 'source-evidence');
  const family = element('div');
  family.append(element('b', '', 'Amazon family evidence'));
  family.append(
    document.createTextNode(
      product.parent_asin
        ? `Parent ${product.parent_asin}`
        : `Standalone ${product.family_asin || product.asin || '—'}`,
    ),
  );
  const variation = element('div');
  variation.append(element('b', '', 'Amazon variation attributes'));
  const sourceAttributes = Object.entries(product.amazon_variation_attributes || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ');
  variation.append(document.createTextNode(sourceAttributes || 'No variation attributes supplied'));
  const stock = element('div');
  stock.append(element('b', '', 'Current listing evidence'));
  stock.append(
    document.createTextNode(
      `${product.status || 'Unknown status'} · ${product.available} available · ${product.inbound} inbound`,
    ),
  );
  evidence.append(family, variation, stock);
  return evidence;
}

function editorFor(product) {
  const form = element('form', 'product-editor');
  form.dataset.sku = product.sku;
  form.dataset.search = `${product.sku} ${product.asin || ''} ${product.source_title || ''}`.toLowerCase();

  const head = element('div', 'product-editor-head');
  if (product.image_url) {
    const image = document.createElement('img');
    image.src = product.image_url;
    image.alt = '';
    image.loading = 'lazy';
    head.append(image);
  } else {
    head.append(element('div', 'product-image-placeholder', 'No image'));
  }
  const identity = element('div', 'product-identity');
  identity.append(element('strong', '', product.sku));
  identity.append(element('span', '', product.source_title));
  identity.append(
    element(
      'small',
      '',
      `${product.asin || 'No ASIN'} · ${text(product.product_role).replaceAll('_', ' ').toLowerCase()}`,
    ),
  );
  head.append(identity);
  head.append(
    element(
      'span',
      `admin-badge${product.needs_configuration ? ' needs' : ''}`,
      product.needs_configuration ? 'Needs configuration' : 'Configured',
    ),
  );
  form.append(head, sourceEvidence(product));

  const fields = element('div', 'product-fields');
  const config = product.config;
  fields.append(
    field('Short UI name', 'name', config.label.name, { placeholder: 'Blank uses the full Amazon title' }),
    field('Current unit COGS · MXN', 'unit_cogs', config.cogs.unit_cogs, {
      type: 'number',
      min: 0,
      max: 1000000,
      step: '0.0001',
      placeholder: 'Required seller value',
    }),
    field('Seller family name', 'family_name', config.taxonomy.family_name, {
      wide: true,
      placeholder: 'Blank leaves the Amazon family evidence unchanged',
    }),
    field('Optional image override · HTTPS', 'image_url', config.label.image_url, {
      placeholder: 'Normally supplied by Amazon Catalog Items',
    }),
    field('Optional Amazon URL override · HTTPS', 'amazon_url', config.label.amazon_url, {
      placeholder: 'Normally built from the ASIN',
    }),
  );

  const taxonomy = element('div', 'taxonomy-editor');
  taxonomy.append(element('span', 'taxonomy-title', 'Seller-facing taxonomy attributes'));
  const rows = element('div', 'taxonomy-rows');
  for (const [name, value] of Object.entries(config.taxonomy.attributes || {})) {
    rows.append(taxonomyRow(name, value));
  }
  if (!rows.children.length) rows.append(taxonomyRow());
  const add = element('button', 'taxonomy-add', '+ Add taxonomy field');
  add.type = 'button';
  add.addEventListener('click', () => rows.append(taxonomyRow()));
  taxonomy.append(rows, add);
  fields.append(taxonomy);

  const actions = element('div', 'product-actions');
  const save = element('button', 'admin-save', 'Save');
  save.type = 'submit';
  const status = element('span', 'product-save-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  actions.append(save, status);
  fields.append(actions);
  form.append(fields);
  form.addEventListener('submit', (event) => saveProduct(event, product));
  return form;
}

function mappedAttributes(form) {
  const attributes = {};
  const folded = new Set();
  for (const row of form.querySelectorAll('.taxonomy-row')) {
    const key = row.querySelector('.taxonomy-key').value.trim();
    const value = row.querySelector('.taxonomy-value').value.trim();
    if (!key && !value) continue;
    if (!key || !value) throw new Error('Each taxonomy row needs both a dimension and a value');
    const normalized = key.toLowerCase();
    if (folded.has(normalized)) throw new Error(`Duplicate taxonomy dimension: ${key}`);
    folded.add(normalized);
    attributes[key] = value;
  }
  return attributes;
}

async function saveProduct(event, product) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('.admin-save');
  const status = form.querySelector('.product-save-status');
  button.disabled = true;
  status.textContent = 'Saving…';
  status.classList.remove('is-error');
  try {
    const costText = form.elements.unit_cogs.value.trim();
    const payload = {
      sku: product.sku,
      expected_revision: state.revision,
      label: {
        name: form.elements.name.value,
        image_url: form.elements.image_url.value,
        amazon_url: form.elements.amazon_url.value,
      },
      taxonomy: {
        family_name: form.elements.family_name.value,
        attributes: mappedAttributes(form),
      },
      cogs: { unit_cogs: costText === '' ? null : Number(costText) },
    };
    const result = await request('/api/admin/product', {
      method: 'POST',
      headers: { 'X-CSRF-Token': state.csrf },
      body: JSON.stringify(payload),
    });
    state.revision = result.revision;
    status.textContent = result.changed ? 'Saved' : 'No changes';
    await loadCatalog({ preserveStatusFor: product.sku, statusText: status.textContent });
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('is-error');
    if (error.status === 401) showAuthenticated(false);
    if (error.status === 409) await loadCatalog();
  } finally {
    button.disabled = false;
  }
}

function renderDeleted(products) {
  const list = byId('deletedProducts');
  list.replaceChildren();
  for (const product of products) {
    const row = element('div', 'history-row');
    row.append(
      element('strong', '', product.sku),
      element('span', '', product.source_title),
      element(
        'span',
        '',
        product.deleted_at ? `Deleted ${text(product.deleted_at).slice(0, 10)}` : 'Deleted',
      ),
    );
    list.append(row);
  }
  if (!products.length) list.append(element('p', '', 'No deleted SKU history.'));
}

function renderCatalog(payload, preserved = {}) {
  state.catalog = payload;
  state.revision = payload.revision;
  byId('currentCount').textContent = payload.summary.current;
  byId('needsCount').textContent = payload.summary.needs_configuration;
  byId('deletedCount').textContent = payload.summary.deleted_history;
  byId('deletedDisclosure').textContent = `(${payload.summary.deleted_history})`;
  byId('lifecycleBasis').textContent =
    `${payload.lifecycle_basis.current}. Deleted history is retained but never editable.`;
  const editors = byId('productEditors');
  editors.replaceChildren();
  for (const product of payload.current_products) {
    const editor = editorFor(product);
    if (product.sku === preserved.preserveStatusFor) {
      editor.querySelector('.product-save-status').textContent = preserved.statusText || '';
    }
    editors.append(editor);
  }
  if (!payload.current_products.length) editors.append(element('p', '', 'No current sellable offers.'));
  renderDeleted(payload.deleted_products);
  applySearch();
}

async function loadCatalog(preserved = {}) {
  const payload = await request('/api/admin/catalog');
  renderCatalog(payload, preserved);
}

function applySearch() {
  const query = byId('adminSearch').value.trim().toLowerCase();
  for (const editor of document.querySelectorAll('.product-editor')) {
    editor.classList.toggle('is-filtered', Boolean(query) && !editor.dataset.search.includes(query));
  }
}

byId('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const status = byId('loginStatus');
  button.disabled = true;
  status.textContent = 'Signing in…';
  status.classList.remove('is-error');
  try {
    const session = await request('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: byId('password').value }),
    });
    state.csrf = session.csrf_token;
    byId('password').value = '';
    showAuthenticated(true);
    await loadCatalog();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('is-error');
  } finally {
    button.disabled = false;
  }
});

byId('logout').addEventListener('click', async () => {
  try {
    await request('/api/admin/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': state.csrf },
      body: '{}',
    });
  } finally {
    state.csrf = null;
    state.catalog = null;
    showAuthenticated(false);
  }
});

byId('adminSearch').addEventListener('input', applySearch);

async function initialize() {
  try {
    const session = await request('/api/admin/session');
    if (!session.configured) {
      byId('loginStatus').textContent = 'Admin access is not configured on this host.';
      byId('loginStatus').classList.add('is-error');
      byId('loginForm').querySelector('button').disabled = true;
      return;
    }
    state.csrf = session.csrf_token;
    showAuthenticated(session.authenticated);
    if (session.authenticated) await loadCatalog();
  } catch (error) {
    byId('loginStatus').textContent = error.message;
    byId('loginStatus').classList.add('is-error');
  }
}

initialize();
