export const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const number1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

const moneyFormatters = new Map();
export const MONEY_PREFIX = '$\u00a0';
const monthYearShort = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthYearLong = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function moneyFormatter(digits) {
  const places = Math.max(0, Number(digits) || 0);
  if (!moneyFormatters.has(places)) {
    moneyFormatters.set(
      places,
      new Intl.NumberFormat('en-US', {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      }),
    );
  }
  return moneyFormatters.get(places);
}

export function integer(value) {
  return number0.format(Math.round(Number(value || 0)));
}

export function formatCount(value, singular, plural = `${singular}s`) {
  const numeric = Math.round(Number(value || 0));
  return `${number0.format(numeric)} ${numeric === 1 ? singular : plural}`;
}

export function money(value, { compact = false, digits = 0 } = {}) {
  const numeric = Number(value || 0);
  const absolute = Math.abs(numeric);
  const sign = numeric < 0 ? '−' : '';
  if (!compact || absolute < 1000 || digits) {
    return `${sign}${MONEY_PREFIX}${moneyFormatter(digits).format(absolute)}`;
  }
  if (absolute < 1_000_000) {
    const scaled = absolute / 1000;
    const places = scaled >= 10 ? 0 : 1;
    return `${sign}${MONEY_PREFIX}${scaled.toFixed(places).replace(/\.0$/, '')}k`;
  }
  const scaled = absolute / 1_000_000;
  return `${sign}${MONEY_PREFIX}${scaled.toFixed(1).replace(/\.0$/, '')}m`;
}

export function formatMonthYear(value, { long = false, fallback = '—' } = {}) {
  if (!value) return fallback;
  const date = new Date(`${String(value).slice(0, 7)}-01T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return fallback;
  return (long ? monthYearLong : monthYearShort).format(date);
}
