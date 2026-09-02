import './data-cache.js';
import { formatCount, formatMonthYear, integer, money, number0, number1, percent } from './format-core.js';

export { formatCount, formatMonthYear, integer, money, number0, number1, percent };
export const BUSINESS_TIME_ZONE = 'America/Mexico_City';
export const BUSINESS_TIME_ZONE_LABEL = 'Mexico City';
const BUSINESS_STANDARD_TIME_ZONE = 'Etc/GMT+6';
const MEXICO_CITY_LAST_DST_END = Date.parse('2022-10-30T07:00:00Z');

function formatterPair(locale, options) {
  return {
    historical: new Intl.DateTimeFormat(locale, { ...options, timeZone: BUSINESS_TIME_ZONE }),
    standard: new Intl.DateTimeFormat(locale, { ...options, timeZone: BUSINESS_STANDARD_TIME_ZONE }),
  };
}

const businessClockFormatters = formatterPair('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const businessTimestampFormatters = formatterPair('en-MX', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatBusinessDate(date, formatters) {
  return (date.getTime() >= MEXICO_CITY_LAST_DST_END ? formatters.standard : formatters.historical).format(
    date,
  );
}

export function formatBusinessClock(value) {
  const localTime =
    typeof value === 'string' &&
    (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ||
      /^\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(value) ||
      /^[A-Za-z]{3} \d{1,2} · ([01]\d|2[0-3]):[0-5]\d$/.test(value));
  if (localTime) return `${value} ${BUSINESS_TIME_ZONE_LABEL}`;
  const date = value === null || value === undefined || value === '' ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) return `--:-- ${BUSINESS_TIME_ZONE_LABEL}`;
  return `${formatBusinessDate(date, businessClockFormatters)} ${BUSINESS_TIME_ZONE_LABEL}`;
}

export function formatBusinessTimestamp(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${formatBusinessDate(date, businessTimestampFormatters)} ${BUSINESS_TIME_ZONE_LABEL}`;
}

export function formatMetricWindow(window) {
  if (!window?.id) return 'Metric window unavailable';
  const start = String(window.start_date || 'start unavailable').slice(0, 10);
  const through = String(window.through_date || 'cutoff unavailable').slice(0, 10);
  const includedDays = Number(window.included_days || 0);
  const sourceUpdate = window.source_as_of
    ? formatBusinessTimestamp(window.source_as_of)
    : 'source update unavailable';
  return `${window.label} · ${window.source} · ${start} to ${through} · ${includedDays} included days · source updated ${sourceUpdate}`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

export function tone(value, { positive = 2, negative = -2 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  if (numeric >= positive) return 'good';
  if (numeric <= negative) return 'bad';
  return '';
}

export function byId(id) {
  return document.getElementById(id);
}

export async function fetchJson(url, options = {}) {
  if (!window.DPPDataCache?.fetchJson) throw new Error('DPP data cache unavailable');
  const cacheOptionKeys = ['ttlMs', 'forceRefresh', 'fetchOptions'];
  const isCacheOptions = cacheOptionKeys.some((key) => Object.prototype.hasOwnProperty.call(options, key));
  return window.DPPDataCache.fetchJson(url, isCacheOptions ? options : { fetchOptions: options });
}

export function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
  return element;
}

export function revealActiveChoice(group) {
  const active = group?.querySelector('[aria-pressed="true"], [aria-selected="true"]');
  if (!active) return;

  requestAnimationFrame(() => {
    if (!active.isConnected || !group.isConnected) return;
    const groupRect = group.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const inset = 6;
    let delta = 0;
    if (activeRect.left < groupRect.left + inset) delta = activeRect.left - groupRect.left - inset;
    else if (activeRect.right > groupRect.right - inset) delta = activeRect.right - groupRect.right + inset;
    if (delta) group.scrollTo({ left: group.scrollLeft + delta, behavior: 'auto' });
  });
}

let interpretationRules = {};
let ruleDialogBound = false;
let ruleDialogTrigger = null;

const ruleDialogFocusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const ruleValueLabels = {
  OK: 'No inventory action',
  PLAN: 'Plan replenishment',
  PRODUCE: 'Produce inventory',
  STOCKOUT: 'Out of stock',
};

function sentenceValue(value) {
  const normalized = String(value).replaceAll('_', ' ').trim();
  return normalized
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1).toLowerCase()}`
    : 'unavailable';
}

function ruleValue(name, value) {
  if (value === null || value === undefined) return 'unavailable';
  if (name === 'is_live') return value ? 'Live day' : 'Closed day';
  if (name.endsWith('_pct')) return percent(Number(value));
  if (['sales_t28', 'sales_change_t28'].includes(name)) return money(Number(value));
  if (
    [
      'orders',
      'operating_decisions',
      'growing',
      'declining',
      'stable',
      'eligible_exposure_days',
      'sessions_t28',
      'units_t28',
      'active_sellable_count',
      'eligible_child_count',
      'portfolio_traffic_median_t28',
    ].includes(name)
  )
    return integer(Number(value));
  if (Array.isArray(value))
    return value.map((item) => ruleValueLabels[item] || sentenceValue(item)).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return ruleValueLabels[value] || sentenceValue(value);
}

function ruleDialogFocusables(dialog) {
  return [...dialog.querySelectorAll(ruleDialogFocusableSelector)].filter(
    (element) =>
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.getClientRects().length > 0,
  );
}

function connectedRuleDialogTrigger(trigger) {
  if (trigger?.isConnected) return trigger;
  const ruleFor = trigger?.dataset.ruleFor;
  if (!ruleFor) return null;
  return document.querySelector(`.rule-trigger[data-rule-for="${CSS.escape(ruleFor)}"]`);
}

function ensureRuleDialog() {
  let dialog = byId('interpretationRuleDialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'interpretationRuleDialog';
  dialog.className = 'rule-dialog';
  dialog.tabIndex = -1;
  dialog.innerHTML = '<div class="rule-dialog__body"></div>';
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !dialog.open) return;
    const focusables = ruleDialogFocusables(dialog);
    const first = focusables[0];
    const last = focusables.at(-1);
    const active = document.activeElement;

    if (!focusables.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    if (focusables.length === 1 || !dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('close', () => {
    const trigger = connectedRuleDialogTrigger(ruleDialogTrigger);
    ruleDialogTrigger = null;
    queueMicrotask(() => trigger?.focus());
  });
  document.body.append(dialog);
  return dialog;
}

export function bindRuleDisclosure(rules = {}) {
  interpretationRules = rules || {};
  if (ruleDialogBound) return;
  ruleDialogBound = true;
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('.rule-trigger');
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    const evaluation = JSON.parse(trigger.dataset.ruleEvaluation || '{}');
    const rule = interpretationRules[evaluation.rule_id] || {};
    const dialog = ensureRuleDialog();
    const inputs = Object.entries(evaluation.inputs || {})
      .map(
        ([name, value]) =>
          `<li><span>${escapeHtml(rule.input_labels?.[name] || 'Supporting measure')}</span><strong>${escapeHtml(ruleValue(name, value))}</strong></li>`,
      )
      .join('');
    const thresholds = (rule.thresholds || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    dialog.querySelector('.rule-dialog__body').innerHTML = `
      <div class="rule-dialog__head">
        <div><small>Decision definition</small><h2>${escapeHtml(rule.name || 'Interpretation rule')}</h2></div>
        <button class="rule-dialog__close" type="button" aria-label="Close rule detail">×</button>
      </div>
      <div class="rule-dialog__result"><span>Current result</span><strong>${escapeHtml(evaluation.label || 'Unavailable')}</strong><small>${escapeHtml(evaluation.eligibility || '')}</small></div>
      <dl><dt>Window</dt><dd>${escapeHtml(rule.window || 'Not documented')}</dd><dt>Eligibility</dt><dd>${escapeHtml(rule.eligibility || 'Not documented')}</dd></dl>
      <h3>Measures used</h3><ul class="rule-dialog__inputs">${inputs || '<li>No measures available</li>'}</ul>
      <h3>How the result is assigned</h3><ul>${thresholds || '<li>No decision bands documented</li>'}</ul>`;
    const closeButton = dialog.querySelector('.rule-dialog__close');
    closeButton.addEventListener('click', () => dialog.close());
    ruleDialogTrigger = trigger;
    dialog.showModal();
    closeButton.focus();
  });
}

export function ruleTrigger(evaluation, rules = interpretationRules) {
  if (!evaluation?.rule_id || !rules?.[evaluation.rule_id]) return '';
  const encoded = escapeHtml(JSON.stringify(evaluation));
  return `<button class="rule-trigger" type="button" data-rule-id="${escapeHtml(evaluation.rule_id)}" data-rule-version="${escapeHtml(evaluation.rule_version)}" data-rule-evaluation="${encoded}" aria-label="Open ${escapeHtml(evaluation.label || 'interpretation')} definition">Definition</button>`;
}

export function mountRuleTrigger(target, evaluation, rules = {}) {
  if (!target) return;
  bindRuleDisclosure(rules);
  const selector = `.rule-trigger[data-rule-for="${CSS.escape(target.id)}"]`;
  const existingTrigger = target.parentElement?.querySelector(selector);
  const restoreFocus = existingTrigger === document.activeElement;
  existingTrigger?.remove();
  const html = ruleTrigger(evaluation, rules).replace(
    'class="rule-trigger"',
    `class="rule-trigger" data-rule-for="${escapeHtml(target.id)}"`,
  );
  if (!html) return;
  target.insertAdjacentHTML('afterend', html);
  if (restoreFocus) target.parentElement?.querySelector(selector)?.focus();
}
