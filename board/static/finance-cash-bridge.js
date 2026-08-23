import { byId, fetchJson } from './ui-utils.js';

const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const CASH_BASIS_LABEL = 'Cash settlement evidence, not sales-period P&L';

function cashMoney(value) {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value || 0);
  const prefix = numeric < 0 ? '−$' : '$';
  return `${prefix}${number0.format(Math.abs(Math.round(numeric)))}`;
}

function step(label, value, kind = '') {
  const numeric = Number(value || 0);
  const tone = numeric < 0 ? 'neg' : numeric > 0 ? 'pos' : '';
  return `<div class="bridge-step ${kind}"><span>${label}</span><strong class="${tone}">${cashMoney(numeric)}</strong></div>`;
}

function shortDate(value) {
  if (!value) return '—';
  const text = String(value).slice(0, 10);
  const date = new Date(`${text}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? text
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderCashBridge(payload) {
  const bridge = payload.cash_bridge || {};
  const card = byId('cashSettlementCard');
  const state = byId('cashBridgeState');
  const sub = byId('cashBridgeSub');
  const body = byId('cashSettlementBridge');
  const summary = byId('cashSettlementSummary');
  if (!card || !state || !sub || !body) return;

  if (!bridge.settlement_id) {
    state.textContent = 'NO SETTLEMENT DATA';
    sub.textContent = `${CASH_BASIS_LABEL} · ${bridge.note || 'No Amazon settlement report is available yet.'}`;
    body.innerHTML =
      '<div class="bridge-step final"><span>Payout bridge</span><strong>Not available</strong></div>';
    if (summary) summary.textContent = 'Not available';
    return;
  }

  if (summary) summary.textContent = cashMoney(bridge.payout);

  const reconciled = bridge.status === 'RECONCILED';
  state.textContent = reconciled ? 'RECONCILED CASH' : 'CHECK RECONCILIATION';
  const range = `${shortDate(bridge.settlement_start_date)}–${shortDate(bridge.settlement_end_date)}`;
  const deposit = shortDate(bridge.deposit_date);
  const delta = Number(bridge.reconciliation_delta || 0);
  sub.textContent = `${CASH_BASIS_LABEL} · ${range} settlement · deposit ${deposit} · ${bridge.line_count || 0} source lines · ${reconciled ? 'Amazon report total reconciled to the cent' : `reconciliation delta ${cashMoney(delta)}`}`;

  body.innerHTML = [
    step('Customer activity incl. IVA', bridge.customer_activity_incl_tax),
    step('IVA withheld by Amazon', bridge.tax_withheld),
    step('Advertising charged in settlement', bridge.advertising),
    step('Amazon fees, refunds & other deductions', bridge.other_deductions),
    step('Reimbursements & other additions', bridge.other_additions),
    step('Payout cash', bridge.payout, 'final'),
  ].join('');
}

async function loadCashBridge() {
  const disclosure = byId('cashSettlementDisclosure');
  if (disclosure && window.matchMedia('(max-width: 640px)').matches) disclosure.open = false;

  try {
    renderCashBridge(await fetchJson('/api/finance'));
  } catch (error) {
    const state = byId('cashBridgeState');
    const sub = byId('cashBridgeSub');
    const summary = byId('cashSettlementSummary');
    if (state) state.textContent = 'UNAVAILABLE';
    if (summary) summary.textContent = 'Unavailable';
    if (sub) sub.textContent = `${CASH_BASIS_LABEL} · Settlement cash bridge unavailable · ${error.message}`;
  }
}

loadCashBridge();
