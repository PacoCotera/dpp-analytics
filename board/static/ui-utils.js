import './data-cache.js';
import { formatCount, formatMonthYear, integer, money, number0, number1 } from './format-core.js';

export { formatCount, formatMonthYear, integer, money, number0, number1 };
export const BUSINESS_TIME_ZONE = 'America/Mexico_City';
export const BUSINESS_TIME_ZONE_LABEL = 'Mexico City';

const businessClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const businessTimestampFormatter = new Intl.DateTimeFormat('en-MX', {
  timeZone: BUSINESS_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatBusinessClock(value) {
  const localTime =
    typeof value === 'string' &&
    (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) ||
      /^\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(value) ||
      /^[A-Za-z]{3} \d{1,2} · ([01]\d|2[0-3]):[0-5]\d$/.test(value));
  if (localTime) return `${value} ${BUSINESS_TIME_ZONE_LABEL}`;
  const date = value === null || value === undefined || value === '' ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) return `--:-- ${BUSINESS_TIME_ZONE_LABEL}`;
  return `${businessClockFormatter.format(date)} ${BUSINESS_TIME_ZONE_LABEL}`;
}

export function formatBusinessTimestamp(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${businessTimestampFormatter.format(date)} ${BUSINESS_TIME_ZONE_LABEL}`;
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

export function percent(value, { digits = 1, sign = true } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const numeric = Number(value);
  const prefix = sign && numeric > 0 ? '+' : '';
  return `${prefix}${numeric.toFixed(digits)}%`;
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

let interpretationRules = {};
let ruleDialogBound = false;

function ruleValue(value) {
  if (value === null || value === undefined) return 'unavailable';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function ensureRuleDialog() {
  let dialog = byId('interpretationRuleDialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'interpretationRuleDialog';
  dialog.className = 'rule-dialog';
  dialog.innerHTML = '<div class="rule-dialog__body"></div>';
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
          `<li><span>${escapeHtml(name.replaceAll('_', ' '))}</span><strong>${escapeHtml(ruleValue(value))}</strong></li>`,
      )
      .join('');
    const thresholds = (rule.thresholds || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    dialog.querySelector('.rule-dialog__body').innerHTML = `
      <div class="rule-dialog__head">
        <div><small>${escapeHtml(rule.id || evaluation.rule_id || 'Interpretation rule')} · v${escapeHtml(rule.version || evaluation.rule_version || '—')}</small><h2>${escapeHtml(rule.name || 'Interpretation rule')}</h2></div>
        <button class="rule-dialog__close" type="button" aria-label="Close rule detail">×</button>
      </div>
      <div class="rule-dialog__result"><span>Current result</span><strong>${escapeHtml(evaluation.label || 'Unavailable')}</strong><small>${escapeHtml(evaluation.eligibility || '')}</small></div>
      <dl><dt>Window</dt><dd>${escapeHtml(rule.window || 'Not documented')}</dd><dt>Eligibility</dt><dd>${escapeHtml(rule.eligibility || 'Not documented')}</dd></dl>
      <h3>Current inputs</h3><ul class="rule-dialog__inputs">${inputs || '<li>No inputs available</li>'}</ul>
      <h3>Thresholds</h3><ul>${thresholds || '<li>No thresholds documented</li>'}</ul>`;
    dialog.querySelector('.rule-dialog__close').addEventListener('click', () => dialog.close());
    dialog.showModal();
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
  target.parentElement?.querySelector(selector)?.remove();
  const html = ruleTrigger(evaluation, rules).replace(
    'class="rule-trigger"',
    `class="rule-trigger" data-rule-for="${escapeHtml(target.id)}"`,
  );
  if (html) target.insertAdjacentHTML('afterend', html);
}
