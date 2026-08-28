import './data-cache.js';

export const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const number1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
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
  const cacheOptionKeys = ['ttlMs', 'forceRefresh', 'fetchOptions'];
  const isCacheOptions = cacheOptionKeys.some((key) => Object.prototype.hasOwnProperty.call(options, key));
  return window.DPPDataCache.fetchJson(url, isCacheOptions ? options : { fetchOptions: options });
}

export function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
  return element;
}
