"use strict";

/* Northstar FX desk client.
   Two venues behind one ticket:
     SIMULATION — local engine, live ECB-anchored ticks, works with no credentials.
     BROKER     — OANDA account, gated by server-side arming flags. */

const state = {
  status: null,
  mode: 'SIMULATION',
  account: null,
  positions: [],
  orders: [],
  quotes: {},
  brokerQuote: null,
  quote: null,
  instrument: 'EUR_USD',
  side: 'BUY',
  rangeDays: 30,
  chart: null,
  series: null,
  liveLine: null,
  socket: null,
  socketConnected: false,
  connected: false
};

const $ = id => document.getElementById(id);

const elements = {
  banner: $('mode-banner'),
  bannerTitle: $('mode-title'),
  bannerText: $('mode-text'),
  bannerAction: $('banner-action'),
  connectionDot: $('connection-dot'),
  connectionLabel: $('connection-label'),
  environmentTag: $('environment-tag'),
  updatedAt: $('updated-at'),
  instrument: $('instrument-select'),
  units: $('units-input'),
  stop: $('stop-input'),
  target: $('target-input'),
  orderButton: $('open-confirmation'),
  ticketMode: $('ticket-mode'),
  ticketFootnote: $('ticket-footnote'),
  dialog: $('confirm-dialog'),
  confirmationInput: $('confirmation-input'),
  confirmationButton: $('confirm-order'),
  toast: $('toast')
};

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function formatMoney(value, currency = 'USD', digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(number);
}

function formatSignedMoney(value, currency = 'USD') {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const formatted = formatMoney(Math.abs(number), currency);
  if (number > 0) return `+${formatted}`;
  if (number < 0) return `-${formatted}`;
  return formatted;
}

function precisionFor(instrument) {
  return instrument.endsWith('_JPY') ? 3 : 5;
}

function formatPrice(value, instrument = state.instrument) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toFixed(precisionFor(instrument));
}

function formatUnits(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '—';
}

function quoteCurrency(instrument = state.instrument) {
  return instrument.split('_')[1];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(message, kind = 'info') {
  elements.toast.textContent = message;
  elements.toast.className = `toast is-visible${kind === 'error' ? ' is-error' : kind === 'warn' ? ' is-warn' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 4200);
}

function showBanner(kind, title, text) {
  elements.banner.classList.toggle('is-live', kind === 'live');
  elements.banner.classList.toggle('is-error', kind === 'error');
  elements.bannerTitle.textContent = title;
  elements.bannerText.textContent = text;
}

function showRetry(visible, handler) {
  elements.bannerAction.hidden = !visible;
  if (visible) {
    elements.bannerAction.textContent = 'Retry';
    elements.bannerAction.onclick = handler;
  }
}

function setConnection(connected, label) {
  state.connected = connected;
  elements.connectionDot.classList.toggle('is-connected', connected);
  elements.connectionDot.classList.toggle('is-error', !connected);
  elements.connectionLabel.textContent = label;
}

function stampUpdated() {
  elements.updatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

/* ---- chart ------------------------------------------------- */

function initializeChart() {
  const container = $('price-chart');
  if (!window.LightweightCharts) {
    container.innerHTML = '<div class="chart-empty">Chart library could not be loaded.</div>';
    return;
  }

  const charts = LightweightCharts;
  state.chart = charts.createChart(container, {
    autoSize: true,
    layout: {
      textColor: '#6a7c76',
      background: { type: charts.ColorType.Solid, color: 'transparent' },
      attributionLogo: true
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.045)' },
      horzLines: { color: 'rgba(255,255,255,0.045)' }
    },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.10)' },
    timeScale: { borderColor: 'rgba(255,255,255,0.10)', timeVisible: false },
    crosshair: {
      vertLine: { color: 'rgba(46,230,168,0.5)' },
      horzLine: { color: 'rgba(46,230,168,0.5)' }
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { mouseWheel: true, pinch: true }
  });

  state.series = state.chart.addSeries(charts.AreaSeries, {
    lineColor: '#2ee6a8',
    lineWidth: 2,
    topLineColor: 'rgba(46,230,168,0.32)',
    topFillColor1: 'rgba(46,230,168,0.28)',
    topFillColor2: 'rgba(46,230,168,0.02)',
    priceLineVisible: true,
    lastValueVisible: true,
    crosshairMarkerRadius: 4,
    crosshairMarkerBackgroundColor: '#2ee6a8'
  });
}

function syncLivePriceLine() {
  if (!state.series || !state.quote || !Number.isFinite(Number(state.quote.mid))) return;
  const price = Number(state.quote.mid);
  if (state.liveLine) {
    state.liveLine.applyOptions({ price });
    return;
  }
  state.liveLine = state.series.createPriceLine({
    price,
    color: 'rgba(110,168,255,0.85)',
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    axisLabelVisible: true,
    title: 'LIVE'
  });
}

async function loadHistory() {
  const [base, quoteCode] = state.instrument.split('_');
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - state.rangeDays);
  const query = new URLSearchParams({
    base,
    symbols: quoteCode,
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10)
  });

  try {
    const payload = await requestJSON(`/api/rates/historical?${query}`);
    const points = Object.entries(payload.rates || {})
      .map(([date, rates]) => ({ time: date, value: Number(rates[quoteCode]) }))
      .filter(point => Number.isFinite(point.value))
      .sort((left, right) => left.time.localeCompare(right.time));

    if (state.series && points.length) {
      state.series.setData(points);
      state.liveLine = null;
      state.chart.timeScale().fitContent();
      syncLivePriceLine();
      $('chart-period').textContent = `${points[0].time} — ${points.at(-1).time} · ${points.length} daily closes`;
      $('chart-subtitle').textContent = state.mode === 'SIMULATION'
        ? 'Daily ECB reference closes with a live simulated tick overlay'
        : 'Daily reference closes from the ECB reference set';
      $('chart-data-mode').textContent = state.mode === 'SIMULATION' ? 'LIVE TICKS' : 'DAILY REFERENCE';
    } else {
      $('chart-period').textContent = 'No reference history for this range';
    }
  } catch (error) {
    $('chart-period').textContent = error.message;
  }
}

/* ---- account + positions ----------------------------------- */

function renderAccount(account) {
  state.account = account;
  const currency = account.currency || 'USD';

  $('metric-nav').textContent = formatMoney(account.NAV, currency);
  $('metric-currency').textContent = account.id === 'SIMULATION'
    ? `Simulated USD account · balance ${formatMoney(account.balance, currency)}`
    : `${currency} account · balance ${formatMoney(account.balance, currency)}`;

  const pnl = Number(account.unrealizedPL);
  const pnlElement = $('metric-pnl');
  pnlElement.textContent = formatSignedMoney(pnl, currency);
  pnlElement.classList.toggle('pnl-positive', pnl > 0);
  pnlElement.classList.toggle('pnl-negative', pnl < 0);

  $('metric-margin').textContent = formatMoney(account.marginAvailable, currency);
  $('metric-trades').textContent = Number.isFinite(Number(account.openTradeCount)) ? account.openTradeCount : '—';

  const returnPct = Number(account.returnPercent);
  $('metric-return').textContent = Number.isFinite(returnPct)
    ? `Session return ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%`
    : 'Session return';
}

function positionRows() {
  if (state.mode === 'SIMULATION') {
    return state.positions.map(position => ({
      key: position.id,
      instrument: position.instrument,
      side: position.side,
      units: Math.abs(Number(position.units)),
      entry: Number(position.entry_price),
      current: Number(position.current_price),
      pnl: Number(position.unrealizedPL),
      stop: Number(position.stop_loss),
      target: Number(position.take_profit),
      closable: true
    }));
  }

  const rows = [];
  for (const position of state.positions) {
    for (const side of ['long', 'short']) {
      const details = position[side] || {};
      const units = Number(details.units);
      if (!units) continue;
      rows.push({
        key: `${position.instrument}-${side}`,
        instrument: position.instrument,
        side: side === 'long' ? 'BUY' : 'SELL',
        units: Math.abs(units),
        entry: Number(details.averagePrice),
        current: null,
        pnl: Number(details.unrealizedPL),
        stop: null,
        target: null,
        closable: false
      });
    }
  }
  return rows;
}

function renderPositions() {
  const rows = positionRows();
  const body = $('positions-body');
  $('positions-count').textContent = `${rows.length} OPEN`;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-row"><strong>No open positions</strong>Send an order from the ticket to open one.</td></tr>';
    return;
  }

  body.innerHTML = rows.map(row => {
    const directionClass = row.side === 'BUY' ? 'direction-buy' : 'direction-sell';
    const pnlClass = row.pnl > 0 ? 'pnl-positive' : row.pnl < 0 ? 'pnl-negative' : '';
    const levels = Number.isFinite(row.stop) && Number.isFinite(row.target)
      ? `${formatPrice(row.stop, row.instrument)} / ${formatPrice(row.target, row.instrument)}`
      : '—';
    const action = row.closable
      ? `<button class="row-button" type="button" data-close-position="${escapeHtml(row.key)}">Close</button>`
      : '<span class="state-chip neutral">BROKER</span>';

    return `<tr>
      <td class="numeric"><span class="pair-name">${escapeHtml(row.instrument.replace('_', ' / '))}</span></td>
      <td class="${directionClass}">${row.side}</td>
      <td class="numeric">${formatUnits(row.units)}</td>
      <td class="numeric">${formatPrice(row.entry, row.instrument)}</td>
      <td class="numeric">${row.current != null && Number.isFinite(row.current) ? formatPrice(row.current, row.instrument) : '—'}</td>
      <td class="money ${pnlClass}">${formatSignedMoney(row.pnl, state.account?.currency || 'USD')}</td>
      <td class="numeric">${levels}</td>
      <td class="action-cell">${action}</td>
    </tr>`;
  }).join('');

  body.querySelectorAll('[data-close-position]').forEach(button => {
    button.addEventListener('click', () => closePosition(button.dataset.closePosition));
  });
}

/* ---- order history + ticker -------------------------------- */

function journalRows() {
  if (state.mode === 'SIMULATION') {
    return state.orders.map(order => ({
      instrument: order.instrument,
      side: order.side,
      units: order.units,
      price: Number.isFinite(Number(order.price)) ? Number(order.price) : null,
      status: order.status,
      reference: order.reference || '—',
      updatedAt: order.updatedAt
    }));
  }
  return state.orders.map(order => ({
    instrument: order.instrument,
    side: order.side,
    units: order.units,
    price: null,
    status: order.status,
    reference: order.brokerOrderId || String(order.clientRequestId || '').slice(0, 8),
    updatedAt: order.updatedAt
  }));
}

function statusChip(status) {
  const label = String(status || 'UNKNOWN').toUpperCase();
  const kind = ['FILLED', 'SUBMITTED'].includes(label) ? 'ok'
    : ['REJECTED', 'ERROR'].includes(label) ? 'bad'
      : ['SUBMITTING', 'UNKNOWN', 'PENDING'].includes(label) ? 'warn'
        : 'neutral';
  return `<span class="state-chip ${kind}">${escapeHtml(label)}</span>`;
}

function renderJournal() {
  const rows = journalRows();
  const body = $('journal-body');
  $('journal-count').textContent = `${rows.length} ${rows.length === 1 ? 'REQUEST' : 'REQUESTS'}`;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-row"><strong>No orders yet</strong>Every order you send is recorded here.</td></tr>';
    return;
  }

  body.innerHTML = rows.map(row => {
    const timestamp = Number(row.updatedAt) > 0 ? Number(row.updatedAt) : Date.parse(row.updatedAt);
    const when = Number.isFinite(timestamp) ? new Date(timestamp) : null;
    const price = row.price != null ? formatPrice(row.price, row.instrument) : '—';
    return `<tr>
      <td class="numeric"><span class="pair-name">${escapeHtml(String(row.instrument || '—').replace('_', ' / '))}</span></td>
      <td class="${row.side === 'SELL' ? 'direction-sell' : 'direction-buy'}">${escapeHtml(row.side || '—')}</td>
      <td class="numeric">${formatUnits(row.units)}</td>
      <td class="numeric">${price}</td>
      <td>${statusChip(row.status)}</td>
      <td class="numeric">${escapeHtml(row.reference || '—')}</td>
      <td class="numeric">${when && !Number.isNaN(when.getTime()) ? when.toLocaleTimeString() : '—'}</td>
    </tr>`;
  }).join('');
}

function renderTicker() {
  const quotes = Object.values(state.quotes);
  if (!quotes.length) return;

  $('ticker-track').innerHTML = quotes.map(quote => {
    const change = Number(quote.changePercent);
    const direction = change >= 0 ? 'up' : 'down';
    const sign = change >= 0 ? '+' : '';
    return `<span class="tape-item">
      <span class="tape-symbol">${escapeHtml(quote.instrument.replace('_', '/'))}</span>
      <span class="tape-price">${formatPrice(quote.mid, quote.instrument)}</span>
      <span class="tape-change ${direction}">${sign}${change.toFixed(2)}%</span>
    </span>`;
  }).join('');
}

/* ---- quote + ticket ---------------------------------------- */

function normalizeQuote(instrument, raw) {
  if (!raw) return null;
  if (raw.bids || raw.asks) {
    const bid = Number(raw.bids?.[0]?.price);
    const ask = Number(raw.asks?.[0]?.price);
    return {
      instrument,
      status: raw.status || 'non-tradeable',
      time: raw.time,
      source: 'OANDA',
      bid,
      ask,
      mid: Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN,
      changePercent: 0
    };
  }
  return { ...raw, instrument: raw.instrument || instrument };
}

function renderQuote(quote) {
  if (!quote) return;
  const previousMid = state.quote ? Number(state.quote.mid) : null;
  state.quote = quote;

  const mid = Number(quote.mid);
  const priceElement = $('quote-price');
  priceElement.textContent = formatPrice(mid);

  if (previousMid != null && Number.isFinite(previousMid) && mid !== previousMid) {
    priceElement.classList.remove('tick-up', 'tick-down');
    void priceElement.offsetWidth;
    priceElement.classList.add(mid > previousMid ? 'tick-up' : 'tick-down');
  }

  $('quote-bid').textContent = formatPrice(quote.bid);
  $('quote-ask').textContent = formatPrice(quote.ask);
  const spread = Number(quote.ask) - Number(quote.bid);
  $('quote-spread').textContent = Number.isFinite(spread) ? formatPrice(spread) : '—';

  const tradeable = quote.status === 'tradeable';
  $('quote-source').textContent = tradeable
    ? (quote.source === 'SIMULATED' ? 'SIMULATED MARKET' : 'OANDA BID / ASK')
    : 'NOT TRADEABLE';
  $('quote-source').style.color = tradeable ? '' : 'var(--loss)';

  const change = Number(quote.changePercent);
  const time = quote.time ? new Date(quote.time).toLocaleTimeString() : '';
  $('quote-change').textContent = Number.isFinite(change) && change !== 0
    ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}% vs session open · ${time}`
    : time;

  syncLivePriceLine();
  updateOrderControls();
}

function currentQuote() {
  if (state.mode === 'SIMULATION') return normalizeQuote(state.instrument, state.quotes[state.instrument]);
  return normalizeQuote(state.instrument, state.brokerQuote);
}

function updatePairLabels() {
  const label = state.instrument.replace('_', ' / ');
  $('chart-title').textContent = label;
  document.title = `${label} | Northstar FX Trading Desk`;
}

function venueReady() {
  if (!state.status || !state.quote) return false;
  if (state.mode === 'SIMULATION') return state.quote.status === 'tradeable';
  return Boolean(state.status.executionAvailable) && state.quote.status === 'tradeable';
}

function suggestLevels() {
  const quote = currentQuote();
  if (!quote || !Number.isFinite(Number(quote.mid))) {
    toast('No quote available to derive levels from.', 'warn');
    return;
  }
  const mid = Number(quote.mid);
  const round = value => Number(value.toFixed(precisionFor(state.instrument)));

  if (state.side === 'BUY') {
    elements.stop.value = String(round(mid - mid * 0.0035));
    elements.target.value = String(round(mid + mid * 0.0070));
  } else {
    elements.stop.value = String(round(mid + mid * 0.0035));
    elements.target.value = String(round(mid - mid * 0.0070));
  }
  updateOrderControls();
}

function renderTicketState() {
  if (!state.status) return;
  const resetButton = $('reset-simulation');

  if (state.mode === 'SIMULATION') {
    showBanner('live', 'Simulation venue active',
      'No broker account is connected, so orders fill locally against live ECB reference rates. Add OANDA credentials and arm the server to switch to broker pricing and execution.');
    elements.bannerAction.hidden = false;
    elements.bannerAction.textContent = 'Reset simulation';
    elements.bannerAction.onclick = resetSimulation;
    elements.environmentTag.textContent = 'SIMULATION';
    elements.environmentTag.className = 'mode-tag is-sim';
    elements.ticketMode.textContent = 'SIMULATION';
    elements.ticketMode.className = 'ticket-mode is-sim';
    elements.ticketFootnote.textContent = 'Orders fill against a simulated market anchored to ECB reference rates. Nothing is sent to a broker. The stop, target and 1% NAV risk cap are enforced exactly as they are live.';
    if (resetButton) resetButton.hidden = false;
    return;
  }

  if (resetButton) resetButton.hidden = true;
  if (state.status.executionAvailable) {
    const isLive = state.status.environment === 'live';
    showBanner('live', isLive ? 'Connected to OANDA — real money' : 'Connected to OANDA practice',
      'Account, pricing and order execution are live. Protective stops and the 1% NAV risk cap are enforced on every order.');
    elements.environmentTag.textContent = isLive ? 'LIVE' : 'PRACTICE';
    elements.environmentTag.className = `mode-tag ${isLive ? 'is-live' : 'is-practice'}`;
    elements.ticketMode.textContent = isLive ? 'LIVE MONEY' : 'PRACTICE';
    elements.ticketMode.className = `ticket-mode ${isLive ? 'is-live' : 'is-practice'}`;
    elements.ticketFootnote.textContent = isLive
      ? 'Real-money market orders go to OANDA. The server re-checks quote, margin and account risk before submission, and every order needs a typed confirmation.'
      : 'Market orders go to the OANDA practice account. The server re-checks quote, margin and account risk before submission.';
  } else {
    showBanner('warn', 'Connected — order execution not armed',
      state.status.executionBlockReason || 'The desk is read only until execution is enabled in the server environment.');
    elements.environmentTag.textContent = 'READ ONLY';
    elements.environmentTag.className = 'mode-tag';
    elements.ticketMode.textContent = 'READ ONLY';
    elements.ticketMode.className = 'ticket-mode';
    elements.ticketFootnote.textContent = state.status.executionBlockReason || 'Order execution is disabled by server configuration.';
  }
}

function updateOrderControls() {
  const units = Number(elements.units.value);
  const stop = Number(elements.stop.value);
  const target = Number(elements.target.value);
  const quote = state.quote;
  const entry = state.side === 'BUY' ? Number(quote?.ask) : Number(quote?.bid);

  const unitsValid = Number.isInteger(units) && units >= 1 && units <= 1000;
  const levelsValid = Number.isFinite(stop) && stop > 0 && Number.isFinite(target) && target > 0;
  const sidesValid = unitsValid && levelsValid && Number.isFinite(entry)
    && (state.side === 'BUY'
      ? stop < entry && target > entry
      : stop > entry && target < entry);

  const enabled = Boolean(venueReady() && sidesValid);
  elements.orderButton.disabled = !enabled;

  if (venueReady()) {
    elements.orderButton.textContent = enabled ? 'Review order' : 'Check units, stop and target';
  } else if (state.mode === 'SIMULATION') {
    elements.orderButton.textContent = 'Waiting for a quote';
  } else {
    elements.orderButton.textContent = 'Connect and arm to trade';
  }

  const risk = unitsValid && stop > 0 && Number.isFinite(entry)
    ? Math.abs(entry - stop) * units
    : NaN;
  $('risk-amount').textContent = Number.isFinite(risk) ? formatMoney(risk, quoteCurrency(), 2) : '—';

  const reward = unitsValid && target > 0 && Number.isFinite(entry)
    ? Math.abs(target - entry)
    : NaN;
  $('risk-ratio').textContent = Number.isFinite(risk) && Number.isFinite(reward) && risk > 0
    ? `1 : ${(reward / risk).toFixed(2)}`
    : '—';
}

/* ---- order flow -------------------------------------------- */

function confirmationPhrase() {
  if (state.status?.confirmationPhrase) return state.status.confirmationPhrase;
  if (state.mode === 'SIMULATION') return 'PLACE SIMULATED ORDER';
  return state.status?.environment === 'live' ? 'PLACE LIVE ORDER' : 'PLACE PRACTICE ORDER';
}

function orderEndpoint() {
  return state.mode === 'SIMULATION' ? '/api/sim/orders' : '/api/live/orders';
}

function openOrderReview() {
  if (!venueReady()) return;
  const units = Number(elements.units.value);
  const stopLoss = Number(elements.stop.value);
  const takeProfit = Number(elements.target.value);

  if (!Number.isInteger(units) || units < 1 || units > 1000 || stopLoss <= 0 || takeProfit <= 0) {
    toast('Enter valid units, a stop loss and a take-profit price first.', 'warn');
    return;
  }

  const phrase = confirmationPhrase();
  const venue = state.mode === 'SIMULATION' ? 'simulated market' : `OANDA ${state.status.environment} account`;
  $('confirm-title').textContent = state.mode === 'SIMULATION' ? 'Confirm simulated order' : 'Confirm broker order';
  $('confirm-summary').textContent = `${state.side} ${units.toLocaleString()} ${state.instrument.replace('_', ' / ')} at market on the ${venue}. Stop ${formatPrice(stopLoss)} · target ${formatPrice(takeProfit)}.`;
  $('confirmation-phrase').textContent = phrase;
  $('confirm-warning').textContent = state.mode === 'SIMULATION'
    ? 'This fills locally and never leaves this server. The engine still enforces the quote, margin and 1% NAV stop-risk checks before it accepts the order.'
    : state.status.environment === 'live'
      ? 'This sends a real-money market order to OANDA. Verify instrument, side, size, stop and target — the server re-checks quote, margin and account risk before submission.'
      : 'This sends a market order to the OANDA practice account. The server re-checks quote, margin and account risk before submission.';

  elements.confirmationInput.value = '';
  elements.confirmationButton.disabled = true;
  elements.confirmationButton.textContent = 'Send order';
  elements.dialog.showModal();
}

async function submitOrder() {
  const phrase = confirmationPhrase();
  if (elements.confirmationInput.value !== phrase) return;

  elements.confirmationButton.disabled = true;
  elements.confirmationButton.textContent = 'Sending…';

  try {
    const result = await requestJSON(orderEndpoint(), {
      method: 'POST',
      body: JSON.stringify({
        instrument: state.instrument,
        side: state.side,
        units: Number(elements.units.value),
        stopLoss: Number(elements.stop.value),
        takeProfit: Number(elements.target.value),
        confirmation: phrase,
        clientRequestId: crypto.randomUUID()
      })
    });
    elements.dialog.close();
    const fillPrice = result.price ?? result.quotedPrice;
    toast(`${result.side} ${formatUnits(result.units)} ${state.instrument.replace('_', ' / ')} filled at ${formatPrice(fillPrice)}.`, 'info');
    await loadDashboard();
    stampUpdated();
  } catch (error) {
    $('confirm-warning').textContent = error.message;
    elements.confirmationButton.disabled = false;
    elements.confirmationButton.textContent = 'Retry review';
  }
}

async function closePosition(positionId) {
  try {
    const result = await requestJSON(`/api/sim/positions/${encodeURIComponent(positionId)}/close`, { method: 'POST' });
    const pnl = Number(result.realizedPnl);
    toast(`Position closed at ${formatPrice(result.exitPrice)} · ${formatSignedMoney(pnl, state.account?.currency || 'USD')} realized.`,
      pnl < 0 ? 'warn' : 'info');
    await loadDashboard();
    stampUpdated();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function resetSimulation() {
  try {
    await requestJSON('/api/sim/reset', { method: 'POST' });
    toast('Simulation reset to the starting balance.', 'info');
    await loadDashboard();
    stampUpdated();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---- data loading ------------------------------------------ */

async function loadStatus() {
  state.status = await requestJSON('/api/live/status');
  state.mode = state.status.mode || (state.status.accountConfigured ? 'BROKER' : 'SIMULATION');
}

async function loadSimState() {
  const sim = await requestJSON('/api/sim/status');
  state.quotes = sim.quotes || {};
  renderAccount(sim.account);
  state.positions = sim.positions || [];
  state.orders = sim.orders || [];
  renderPositions();
  renderJournal();
  renderTicker();
  renderQuote(currentQuote());
}

async function loadBrokerQuote() {
  try {
    const payload = await requestJSON(`/api/live/pricing?instruments=${encodeURIComponent(state.instrument)}`);
    const raw = (payload.prices || []).find(price => price.instrument === state.instrument);
    state.brokerQuote = raw || null;
    renderQuote(currentQuote());
  } catch (error) {
    state.brokerQuote = null;
    setConnection(false, 'Quote unavailable');
    toast(error.message, 'error');
  }
}

async function loadBrokerState() {
  const [account, positions, orders] = await Promise.all([
    requestJSON('/api/live/account'),
    requestJSON('/api/live/positions'),
    requestJSON('/api/live/orders/recent')
  ]);
  renderAccount(account);
  state.positions = positions.positions || [];
  state.orders = orders.orders || [];
  renderPositions();
  renderJournal();
  await loadBrokerQuote();
}

async function loadDashboard() {
  await loadStatus();
  if (state.mode === 'SIMULATION') {
    await loadSimState();
    const realtime = state.socketConnected !== false;
    setConnection(realtime, realtime ? 'Live · simulation' : 'Polling · simulation');
  } else {
    await loadBrokerState();
    setConnection(true, `Live · OANDA ${state.status.environment}`);
  }
  renderTicketState();
  updateOrderControls();
}

async function refreshDashboard() {
  try {
    await loadDashboard();
    stampUpdated();
    showRetry(false);
  } catch (error) {
    setConnection(false, 'Server unavailable');
    showBanner('error', 'Trading server unreachable', error.message);
    showRetry(true, refreshDashboard);
  }
}

/* ---- realtime ---------------------------------------------- */

function applySimPayload(payload) {
  if (!payload || state.mode !== 'SIMULATION') return;

  if (payload.quotes) {
    state.quotes = payload.quotes;
    renderTicker();
    renderQuote(currentQuote());
  }
  if (payload.account) renderAccount(payload.account);
  if (payload.positions) {
    state.positions = payload.positions;
    renderPositions();
  }
  if (payload.orders) {
    state.orders = payload.orders;
    renderJournal();
  }

  for (const trade of payload.closed || []) {
    const pnl = Number(trade.realizedPnl);
    toast(`${trade.instrument.replace('_', ' / ')} ${trade.reason} at ${formatPrice(trade.exitPrice, trade.instrument)} · ${formatSignedMoney(pnl, state.account?.currency || 'USD')}`,
      trade.reason === 'STOP' ? 'warn' : 'info');
  }

  stampUpdated();
}

function connectSocket() {
  if (typeof window.io !== 'function') {
    state.socketConnected = false;
    return;
  }
  const socket = window.io();
  state.socket = socket;
  state.socketConnected = true;

  socket.on('connect', () => {
    state.socketConnected = true;
    if (state.mode === 'SIMULATION') setConnection(true, 'Live · simulation');
  });
  socket.on('disconnect', () => {
    state.socketConnected = false;
    setConnection(false, 'Realtime lost · polling');
  });
  socket.on('sim:update', applySimPayload);
}

/* ---- wiring ------------------------------------------------- */

elements.instrument.addEventListener('change', async event => {
  state.instrument = event.target.value;
  state.quote = null;
  state.liveLine = null;
  updatePairLabels();
  if (state.mode === 'SIMULATION') {
    renderQuote(currentQuote());
    renderTicker();
  } else {
    await loadBrokerQuote();
  }
  await loadHistory();
});

document.querySelectorAll('.side-button').forEach(button => {
  button.addEventListener('click', () => {
    state.side = button.dataset.side;
    document.querySelectorAll('.side-button').forEach(item => {
      const selected = item === button;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    updateOrderControls();
  });
});

document.querySelectorAll('.step-button').forEach(button => {
  button.addEventListener('click', () => {
    const next = Math.max(1, Math.min(1000, Number(elements.units.value) + Number(button.dataset.step)));
    elements.units.value = String(next);
    updateOrderControls();
  });
});

[elements.units, elements.stop, elements.target].forEach(input => {
  input.addEventListener('input', updateOrderControls);
});

$('suggest-levels').addEventListener('click', suggestLevels);
$('refresh-button').addEventListener('click', refreshDashboard);
elements.orderButton.addEventListener('click', openOrderReview);
$('cancel-confirmation').addEventListener('click', () => elements.dialog.close());
$('reset-simulation').addEventListener('click', resetSimulation);

elements.confirmationInput.addEventListener('input', () => {
  elements.confirmationButton.disabled = elements.confirmationInput.value !== confirmationPhrase();
});
elements.confirmationButton.addEventListener('click', submitOrder);

elements.dialog.addEventListener('close', () => {
  elements.confirmationInput.value = '';
  elements.confirmationButton.disabled = true;
});

document.querySelectorAll('[data-range]').forEach(button => {
  button.addEventListener('click', async () => {
    state.rangeDays = Number(button.dataset.range);
    document.querySelectorAll('[data-range]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    await loadHistory();
  });
});

document.querySelectorAll('.topnav a').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.topnav a').forEach(item => item.classList.toggle('active', item === link));
  });
});

/* ---- boot ---------------------------------------------------- */

async function boot() {
  initializeChart();
  updatePairLabels();
  connectSocket();
  await refreshDashboard();
  await loadHistory();

  window.setInterval(async () => {
    try {
      await loadDashboard();
      stampUpdated();
    } catch (_error) {
      setConnection(false, 'Server unavailable');
    }
  }, 20000);
}

boot();
