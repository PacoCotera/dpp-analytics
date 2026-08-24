import './data-cache.js';

export const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const number1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function money(value, { compact = false } = {}) {
  const numeric = Number(value || 0);
  if (!compact || Math.abs(numeric) < 1000) return `$${number0.format(Math.round(numeric))}`;
  if (Math.abs(numeric) < 1_000_000) {
    const scaled = numeric / 1000;
    const digits = Math.abs(scaled) >= 10 ? 0 : 1;
    return `$${scaled.toFixed(digits).replace(/\.0$/, '')}k`;
  }
  const scaled = numeric / 1_000_000;
  return `$${scaled.toFixed(1).replace(/\.0$/, '')}m`;
}

export function percent(value, { digits = 1, sign = true } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const numeric = Number(value);
  const prefix = sign && numeric > 0 ? '+' : '';
  return `${prefix}${numeric.toFixed(digits)}%`;
}

export function integer(value) {
  return number0.format(Math.round(Number(value || 0)));
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
  return window.DPPDataCache.fetchJson(url, options);
}

export function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
  return element;
}
