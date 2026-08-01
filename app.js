const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const signed = (value, format) => `${value >= 0 ? '+' : '−'}${format(Math.abs(value))}`;
const number = value => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);

const shortCurrency = (value) => {
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(2)}Cr`;
  if (value >= 100000) return `₹${(value / 100000).toFixed(2)}L`;
  return currency.format(value);
};

// View navigation and page switching logic
document.querySelectorAll('.nav-link').forEach((link) => {
  link.addEventListener('click', (e) => {
    const activeLink = document.querySelector('.nav-link.active');
    if (activeLink) activeLink.classList.remove('active');
    link.classList.add('active');

    const href = link.getAttribute('href');
    const overviewView = document.querySelector('#overview-view');
    const dashboardView = document.querySelector('#dashboard-view');

    if (href === '#dashboard') {
      overviewView.hidden = true;
      dashboardView.hidden = false;
      renderDashboard();
    } else {
      dashboardView.hidden = true;
      overviewView.hidden = false;
    }
  });
});

document.querySelectorAll('.range button').forEach((button) => {
  button.addEventListener('click', () => {
    const selected = document.querySelector('.range .selected');
    if (selected) selected.classList.remove('selected');
    button.classList.add('selected');
  });
});

let currentRange = 'all';
function filterByRange(trades, range) {
  if (range === 'all') return trades;
  const days = { '30d': 30, '90d': 90, '180d': 180 }[range] || Infinity;
  const cutoff = new Date(Date.now() - days * 86400000);
  return trades.filter(t => new Date(t.closeDate || t.date) >= cutoff);
}

document.querySelectorAll('#db-range-selector .range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#db-range-selector .range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    renderDashboard();
  });
});

function renderHoldings(holdings, total) {
  const list = document.querySelector('#holdings-list');
  if (!list) return;
  list.replaceChildren(...holdings.slice(0, 4).map((holding) => {
    const row = document.createElement('div');
    const changeClass = holding.dayChangePercent >= 0 ? 'positive' : 'negative';
    row.className = 'holding-row';
    row.innerHTML = `<span class="company"><i class="logo hdfc">${holding.symbol[0]}</i><b>${holding.symbol}<small>${holding.exchange}:${holding.symbol}</small></b></span><strong>${currency.format(holding.lastPrice)}</strong><b class="${changeClass}">${signed(holding.dayChangePercent, value => `${value.toFixed(2)}%`)}</b><span>${total ? ((holding.value / total) * 100).toFixed(1) : 0}%</span>`;
    return row;
  }));
}

function renderLivePanels(data) {
  const { portfolio, risk, positions, orders } = data;
  const root = document.querySelector('#live-insights');
  if (!root) return;
  root.hidden = false;
  root.innerHTML = `<div class="live-heading"><div><p class="eyebrow">LIVE PORTFOLIO ANALYSIS</p><h2>Decision-ready panels</h2><p>Broker-sourced data, updated just now.</p></div><span class="live-pill">● ${data.profile.broker} CONNECTED</span></div><div class="live-grid"><article class="data-panel"><p class="eyebrow">CASH & EXPOSURE</p><h3>${currency.format(portfolio.cash)}</h3><p>Available equity cash</p><div class="metric-line"><span>Equity exposure</span><b>${currency.format(portfolio.equityValue)}</b></div><div class="metric-line"><span>Open positions</span><b>${positions.length}</b></div></article><article class="data-panel"><p class="eyebrow">CONCENTRATION RISK</p><h3>${risk.concentration}</h3><p>Largest holding is ${risk.topWeight.toFixed(1)}% of portfolio value</p><div class="risk-bar"><i style="width:${Math.min(risk.topWeight, 100)}%"></i></div><small>Concentration signal, not investment advice.</small></article><article class="data-panel growth-panel"><p class="eyebrow">GROWTH SCENARIO · NOT A PREDICTION</p><h3 id="growth-value">${currency.format(portfolio.value * 1.12)}</h3><p>Illustrative 1-year value at <b id="growth-rate-label">12%</b> annual growth</p><input id="growth-rate" type="range" min="0" max="25" value="12" step="1" aria-label="Annual growth assumption"/><div class="scenario-scale"><span>0%</span><span>25%</span></div></article><article class="data-panel"><p class="eyebrow">ORDERS & POSITIONS</p><h3>${orders.length}</h3><p>Most recent broker orders</p><div class="metric-line"><span>Open positions</span><b>${positions.length}</b></div><div class="metric-line"><span>Portfolio P&amp;L</span><b class="${portfolio.pnl >= 0 ? 'positive' : 'negative'}">${signed(portfolio.pnl, currency.format)}</b></div></article></div><article class="data-panel full-panel"><div class="panel-title"><div><p class="eyebrow">HOLDINGS DETAILS</p><h3>Live delivery portfolio</h3></div><span>${portfolio.holdingCount} holdings</span></div><div class="detail-table"><div class="detail-head"><span>INSTRUMENT</span><span>QTY</span><span>AVG PRICE</span><span>LTP</span><span>P&amp;L</span></div>${data.holdings.map(h => `<div><span><b>${h.symbol}</b><small>${h.exchange}</small></span><span>${number(h.quantity)}</span><span>${currency.format(h.averagePrice)}</span><span>${currency.format(h.lastPrice)}</span><span class="${h.pnl >= 0 ? 'positive' : 'negative'}">${signed(h.pnl, currency.format)}</span></div>`).join('')}</div></article>`;
  const growth = document.querySelector('#growth-rate');
  growth.addEventListener('input', () => {
    const rate = Number(growth.value);
    document.querySelector('#growth-rate-label').textContent = `${rate}%`;
    document.querySelector('#growth-value').textContent = currency.format(portfolio.value * (1 + rate / 100));
  });
}

function renderExtendedPanels(data) {
  const root = document.querySelector('#live-insights');
  if (!root) return;
  const { allocation, attribution, orders, positions, risk, portfolio } = data;
  const exposure = allocation.equity + allocation.cash + allocation.derivatives || 1;
  const allocationRows = [['Equity holdings', allocation.equity], ['Available cash', allocation.cash], ['Open derivative notional', allocation.derivatives]].map(([label, value]) => `<div class="allocation-row"><span>${label}<div class="bar-track"><i style="width:${Math.min(value / exposure * 100, 100)}%"></i></div></span><b>${currency.format(value)}<small>${(value / exposure * 100).toFixed(1)}%</small></b></div>`).join('');
  const contributors = attribution.map(item => `<div class="contributor-row"><span><b>${item.symbol}</b><small>Contribution to holding P&amp;L</small></span><b class="${item.pnl >= 0 ? 'positive' : 'negative'}">${signed(item.pnl, currency.format)}</b></div>`).join('') || '<p>No current holdings to attribute.</p>';
  const orderRows = orders.length ? orders.map(order => `<div class="order-row"><span><b>${order.tradingsymbol}</b><small>${order.exchange} · ${order.transaction_type}</small></span><span>${order.quantity} qty</span><span>${currency.format(order.price || order.average_price || 0)}</span><span class="status ${order.status.replaceAll(' ', '_')}">${order.status}</span></div>`).join('') : '<p>No recent orders returned by the broker.</p>';
  root.insertAdjacentHTML('beforeend', `<div class="extended-grid"><article class="analysis-panel"><p class="eyebrow">ACTUAL ALLOCATION</p><h3>Asset and exposure mix</h3>${allocationRows}</article><article class="analysis-panel"><p class="eyebrow">P&amp;L ATTRIBUTION</p><h3>Largest holding contributors</h3>${contributors}</article><article class="analysis-panel"><p class="eyebrow">POSITION MONITOR</p><h3>${positions.length ? `${positions.length} open position${positions.length > 1 ? 's' : ''}` : 'No open positions'}</h3><p>Net positions and intraday mark-to-market are sourced directly from the connected broker.</p><div class="metric-line"><span>Winning holdings</span><b>${risk.winners}</b></div><div class="metric-line"><span>Loss-making holdings</span><b>${risk.losers}</b></div><div class="metric-line"><span>Day P&amp;L</span><b class="${portfolio.dayPnl >= 0 ? 'positive' : 'negative'}">${signed(portfolio.dayPnl, currency.format)}</b></div></article><article class="analysis-panel"><p class="eyebrow">ORDER HISTORY</p><h3>Latest broker orders</h3>${orderRows}</article></div><div class="placeholder-grid"><article class="placeholder-panel"><p class="eyebrow">HISTORICAL PERFORMANCE</p><h3>Drawdown, Sharpe & benchmark</h3><p>Requires a persisted daily portfolio-value series and selected benchmark history. It is intentionally not calculated from one intraday snapshot.</p></article><article class="placeholder-panel"><p class="eyebrow">MARKET BREADTH & SECTORS</p><h3>Advancers, decliners & heatmap</h3><p>Requires a broad NSE/BSE quote universe and sector mapping. This panel will be live only once market-data ingestion is added.</p></article><article class="placeholder-panel"><p class="eyebrow">CASH FLOWS & TAX</p><h3>Income, charges & realised gains</h3><p>Requires retained trade history, dividend records, and tax-lot rules. Current-day broker trades are available but insufficient for correct tax reporting.</p></article></div>`);
}

// Render dynamic Asset Allocation donut chart & legend
function renderAssetAllocation(data) {
  const totalValue = data.portfolio.value || 3184620;
  const cash = data.portfolio.cash || 644620;

  let equity = 0;
  let mf = 0;
  let debt = cash; // treat cash as debt/bond-like asset for fixed income portion
  let gold = 0;

  (data.holdings || []).forEach(h => {
    const sym = h.symbol.toUpperCase();
    if (sym.startsWith('INF') || sym.includes('MUTUAL')) {
      mf += h.value;
    } else if (sym.endsWith('GS') || sym.includes('BOND') || sym.includes('NCD') || sym.includes('SGB')) {
      debt += h.value;
    } else if (sym.includes('BEES') || sym.includes('ETF') || sym.includes('GOLD')) {
      gold += h.value;
    } else {
      equity += h.value;
    }
  });

  const equityPct = (equity / totalValue) * 100;
  const mfPct = (mf / totalValue) * 100;
  const debtPct = (debt / totalValue) * 100;
  const goldPct = (gold / totalValue) * 100;

  // Center text
  const strongTotal = document.querySelector('.donut strong');
  if (strongTotal) {
    strongTotal.textContent = shortCurrency(totalValue);
  }

  // Legend list percentages
  const listItems = document.querySelectorAll('.allocations ul li');
  if (listItems.length === 4) {
    listItems[0].querySelector('strong').textContent = `${equityPct.toFixed(1)}%`;
    listItems[1].querySelector('strong').textContent = `${mfPct.toFixed(1)}%`;
    listItems[2].querySelector('strong').textContent = `${debtPct.toFixed(1)}%`;
    listItems[3].querySelector('strong').textContent = `${goldPct.toFixed(1)}%`;
  }

  // Conic gradient representation
  const donut = document.querySelector('.donut');
  if (donut) {
    donut.style.background = `conic-gradient(
      #1c9167 0% ${equityPct}%,
      #a9e8cf ${equityPct}% ${equityPct + mfPct}%,
      #e0cf8e ${equityPct + mfPct}% ${equityPct + mfPct + debtPct}%,
      #607d75 ${equityPct + mfPct + debtPct}% 100%
    )`;
  }
}

// Mock/Demo Data Generator for Dashboard
const getMockDemoData = () => ({
  portfolio: { value: 3184620, invested: 2540000, equityValue: 2540000, cash: 644620, pnl: 49754, dayPnl: 42860, returnPercent: 18.62, topWeight: 13.8, holdingCount: 3 },
  holdings: [
    { symbol: 'HDFCBANK', exchange: 'NSE', quantity: 70, averagePrice: 1540, lastPrice: 1964.20, pnl: 29694, value: 137494, dayPnl: 1960, dayChangePercent: 1.42 },
    { symbol: 'RELIANCE', exchange: 'NSE', quantity: 90, averagePrice: 1220, lastPrice: 1472.80, pnl: 22752, value: 132552, dayPnl: 1120, dayChangePercent: 0.86 },
    { symbol: 'INFY', exchange: 'NSE', quantity: 80, averagePrice: 1650, lastPrice: 1616.35, pnl: -2692, value: 129308, dayPnl: -440, dayChangePercent: -0.34 }
  ],
  positions: [],
  orders: [],
  trades: [],
  profile: { user_name: 'Anurag Jha', broker: 'Zerodha' }
});

// ── Tradebook state (populated from /api/tradebook) ─────────────────────────
let tradebookData = null; // { trades, realizedPnl, loaded, filename, rawCount }

async function loadTradebook() {
  try {
    const res = await fetch('/api/tradebook');
    if (!res.ok) return;
    const d = await res.json();
    tradebookData = d;
    renderTradebookBanner();
  } catch { /* no tradebook loaded */ }
}

function renderTradebookBanner() {
  const banner = document.getElementById('db-tradebook-banner');
  if (!banner) return;
  const connected = window.lastDashboardData?.connected;

  if (tradebookData && tradebookData.loaded) {
    const ts = tradebookData.uploadedAt ? new Date(tradebookData.uploadedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const isSync = tradebookData.source === 'kite-sync';
    banner.innerHTML = `
      <div class="tb-banner tb-banner--loaded">
        <div class="tb-info">
          <span class="tb-icon">${isSync ? '⚡' : '📄'}</span>
          <div>
            <strong>${isSync ? 'Kite trades synced' : 'Tradebook loaded'}</strong>
            <small>${tradebookData.rawCount} raw trades · ${tradebookData.trades.length} completed · ${ts}</small>
          </div>
        </div>
        ${connected ? '<button class="tb-upload-btn" onclick="syncTradesFromKite()">↻ Sync Now</button>' : ''}
        <label class="tb-upload-btn" for="tb-file-input">↑ Update CSV</label>
        <input type="file" id="tb-file-input" accept=".csv,.xlsx" style="display:none"/>
      </div>`;
  } else if (connected) {
    banner.innerHTML = `
      <div class="tb-banner tb-banner--empty">
        <div class="tb-info">
          <span class="tb-icon">⚡</span>
          <div>
            <strong>Sync trades from Zerodha</strong>
            <small>Fetch today's trades via Kite API. For historical data, upload CSV from Console → Reports → Tradebook.</small>
          </div>
        </div>
        <button class="tb-upload-btn tb-upload-btn--primary" onclick="syncTradesFromKite()">⚡ Sync Trades</button>
        <label class="tb-upload-btn" for="tb-file-input">↑ Upload CSV</label>
        <input type="file" id="tb-file-input" accept=".csv,.xlsx" style="display:none"/>
      </div>`;
  } else {
    banner.innerHTML = `
      <div class="tb-banner tb-banner--empty">
        <div class="tb-info">
          <span class="tb-icon">📂</span>
          <div>
            <strong>Upload your Zerodha Tradebook</strong>
            <small>Download from Zerodha Console → Reports → Tradebook (CSV). Enables accurate realized P&amp;L &amp; trade analytics.</small>
          </div>
        </div>
        <label class="tb-upload-btn tb-upload-btn--primary" for="tb-file-input">↑ Upload CSV / Excel</label>
        <input type="file" id="tb-file-input" accept=".csv,.xlsx" style="display:none"/>
      </div>`;
  }
  const input = document.getElementById('tb-file-input');
  if (input) input.addEventListener('change', handleTradebookUpload);
}

async function handleTradebookUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const banner = document.getElementById('db-tradebook-banner');
  banner.innerHTML = `<div class="tb-banner tb-banner--loading"><span class="tb-spinner"></span><span>Processing ${file.name}…</span></div>`;
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/tradebook/upload', { method: 'POST', body: form });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Upload failed');
    // Reload tradebook from server
    const reload = await fetch('/api/tradebook');
    tradebookData = await reload.json();
    renderTradebookBanner();
    // Re-render dashboard with new data
    renderDashboard();
    banner.querySelector('.tb-banner')?.classList.add('tb-banner--success');
  } catch (err) {
    banner.innerHTML = `<div class="tb-banner tb-banner--error">❌ ${err.message} <button onclick="renderTradebookBanner()">Retry</button></div>`;
  }
}

async function syncTradesFromKite() {
  const banner = document.getElementById('db-tradebook-banner');
  if (banner) banner.innerHTML = '<div class="tb-banner tb-banner--loading"><span class="tb-spinner"></span><span>Syncing trades from Zerodha...</span></div>';
  try {
    const res = await fetch('/api/trades/sync', { method: 'POST' });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Sync failed');
    await loadTradebook();
    renderTradebookBanner();
    renderDashboard();
  } catch (err) {
    if (banner) banner.innerHTML = `<div class="tb-banner tb-banner--error">Sync: ${err.message} <button onclick="renderTradebookBanner()">Dismiss</button></div>`;
  }
}

function getTradeHistory(portfolioData) {
  // Use real tradebook if available
  if (tradebookData && tradebookData.loaded && tradebookData.trades && tradebookData.trades.length > 0) {
    // Add capital tracking to real trades
    const currentValue = portfolioData.portfolio.value || 0;
    const realizedPnl = tradebookData.realizedPnl || 0;
    const unrealizedPnl = portfolioData.portfolio.pnl || 0;
    // Starting capital = current value - total profit
    let cap = Math.round(currentValue - realizedPnl - unrealizedPnl);
    return tradebookData.trades.map(t => {
      const obj = {
        ...t,
        capital: Math.max(cap, 1),
        planFollowed: true,
        risk: Math.abs(t.netPnl) * 0.5,
        rMultiple: t.pnlPercent ? t.pnlPercent / 8 : 0,
      };
      cap += t.netPnl;
      return obj;
    });
  }
  return []; // No tradebook — return empty, dashboard will show upload prompt
}

// Legacy stub kept for TS/lint compatibility — no longer used
function generateTradeHistory(data) {
  const currentValue = data.portfolio.value || 3184620;
  const holdings = data.holdings || [];

  // If actual Zerodha trade history is returned by the broker API, prioritize and parse it!
  if (data.trades && data.trades.length > 0) {
    let cap = data.portfolio.invested || currentValue;
    return data.trades.map((t, idx) => {
      const price = Number(t.average_price || t.price || 100);
      const qty = Number(t.quantity || 1);
      const cost = price * qty;
      const pnl = Number(t.pnl || 0);
      const charges = cost * 0.001;
      const netPnl = pnl - charges;
      const pnlPct = cost ? (pnl / cost * 100) : 0;
      const dateStr = (t.fill_timestamp || t.order_timestamp || '').split('T')[0] || '2026-07-19';
      const m = new Date(dateStr).getMonth() + 1;

      const tradeObj = {
        tradeNo: idx + 1,
        month: m,
        symbol: t.tradingsymbol,
        date: dateStr,
        closeDate: dateStr,
        qty: qty,
        entryPrice: price,
        exitPrice: price + (pnl / (qty || 1)),
        pnl: pnl,
        charges: charges,
        netPnl: netPnl,
        pnlPercent: pnlPct,
        holdingDays: 1,
        planFollowed: true,
        capital: cap,
        risk: cost * 0.08,
        rMultiple: pnlPct / 8
      };
      cap += netPnl;
      return tradeObj;
    });
  }

  // Fallback to journal template if no broker trade history API endpoint is returned
  const startingCapital = Math.round(currentValue * 0.75);
  // Map real symbols from connected Zerodha holdings if available
  if (holdings.length > 0) {
    baseTradesData.forEach((trade, idx) => {
      const holdingIdx = idx % holdings.length;
      trade.symbol = holdings[holdingIdx].symbol;
    });
  }

  let currentCap = startingCapital;
  const trades = [];

  baseTradesData.forEach((bt, idx) => {
    const cost = currentCap * 0.0467;
    const pnl = cost * (bt.pnlPct / 100);
    const charges = cost * 0.001; // 0.1% transaction charges
    const netPnl = pnl - charges;

    trades.push({
      tradeNo: idx + 1,
      month: bt.m,
      symbol: bt.symbol,
      date: bt.date,
      closeDate: bt.closeDate,
      qty: Math.round(cost / 1500) || 1,
      entryPrice: 1500,
      exitPrice: Math.round(1500 * (1 + bt.pnlPct / 100)),
      pnl: pnl,
      charges: charges,
      netPnl: netPnl,
      pnlPercent: bt.pnlPct,
      holdingDays: bt.days,
      planFollowed: bt.plan,
      capital: currentCap,
      risk: cost * 0.08,
      rMultiple: bt.pnlPct / 8
    });

    currentCap += netPnl;
  });

  return [];
}

function drawEquityChart(trades, startingCapital) {
  const svg = document.getElementById('db-equity-chart');
  if (!svg) return;
  svg.innerHTML = '';

  const w = 600, h = 300;
  const ml = 58, mr = 24, mt = 24, mb = 36;
  const cw = w - ml - mr, ch = h - mt - mb;

  if (!trades.length) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', w / 2); t.setAttribute('y', h / 2);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', '#9aa69e');
    t.setAttribute('font-size', '13'); t.setAttribute('font-family', 'Manrope, sans-serif');
    t.textContent = 'Upload tradebook to see equity curve';
    svg.appendChild(t);
    return;
  }

  let cumPnL = 0;
  const points = [{ x: 0, y: 0, label: 'Start', detail: 'Capital: ' + currency.format(startingCapital) }];
  trades.forEach((t, idx) => {
    cumPnL += t.netPnl;
    points.push({
      x: idx + 1,
      y: (cumPnL / startingCapital) * 100,
      label: `Trade ${idx + 1}`,
      detail: `${t.symbol} · ${t.pnlPercent >= 0 ? '+' : ''}${t.pnlPercent.toFixed(2)}% · P&L: ${currency.format(t.netPnl)}`
    });
  });

  const yVals = points.map(p => p.y);
  const yPad = Math.max((Math.max(...yVals) - Math.min(...yVals)) * 0.15, 2);
  let yMin = Math.floor((Math.min(...yVals) - yPad) / 5) * 5;
  let yMax = Math.ceil((Math.max(...yVals) + yPad) / 5) * 5;
  if (yMax === yMin) { yMax += 5; yMin -= 5; }

  const gx = x => ml + (x / trades.length) * cw;
  const gy = y => mt + ((yMax - y) / (yMax - yMin)) * ch;

  const positive = cumPnL >= 0;
  const clr = positive ? '#16835d' : '#c55550';
  const clrLight = positive ? '#84e2bd' : '#e8a0a0';

  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };

  const defs = el('defs');
  defs.innerHTML = `<linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0%" stop-color="${clrLight}" stop-opacity="0.4"/>
    <stop offset="100%" stop-color="${clrLight}" stop-opacity="0.03"/>
  </linearGradient>
  <filter id="eq-glow"><feGaussianBlur stdDeviation="2.5" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;
  svg.appendChild(defs);

  for (let i = 0; i <= 5; i++) {
    const yVal = yMin + (i / 5) * (yMax - yMin);
    const yy = gy(yVal);
    svg.appendChild(el('line', { x1: ml, y1: yy, x2: w - mr, y2: yy, stroke: '#eef1ee', 'stroke-width': 1 }));
    const lbl = el('text', { x: ml - 10, y: yy + 3.5, 'text-anchor': 'end', fill: '#9aa69e', 'font-size': 10, 'font-family': 'DM Mono, monospace' });
    lbl.textContent = `${yVal >= 0 ? '+' : ''}${yVal.toFixed(1)}%`;
    svg.appendChild(lbl);
  }

  if (yMin < 0 && yMax > 0) {
    svg.appendChild(el('line', { x1: ml, y1: gy(0), x2: w - mr, y2: gy(0), stroke: '#c8cdc8', 'stroke-width': 1.2, 'stroke-dasharray': '5 3' }));
  }

  const total = trades.length;
  const step = total <= 20 ? 5 : total <= 60 ? 10 : total <= 120 ? 20 : 30;
  for (let x = 0; x <= total; x += step) {
    const lbl = el('text', { x: gx(x), y: h - mb + 16, 'text-anchor': 'middle', fill: '#9aa69e', 'font-size': 10, 'font-family': 'DM Mono, monospace' });
    lbl.textContent = x === 0 ? 'Start' : `#${x}`;
    svg.appendChild(lbl);
  }
  if (total % step !== 0) {
    const lbl = el('text', { x: gx(total), y: h - mb + 16, 'text-anchor': 'end', fill: '#9aa69e', 'font-size': 10, 'font-family': 'DM Mono, monospace' });
    lbl.textContent = `#${total}`;
    svg.appendChild(lbl);
  }

  const coords = points.map(p => [gx(p.x), gy(p.y)]);
  let pathD = `M ${coords[0][0]} ${coords[0][1]}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(i - 1, 0)];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[Math.min(i + 2, coords.length - 1)];
    const tension = 0.25;
    pathD += ` C ${p1[0] + (p2[0] - p0[0]) * tension} ${p1[1] + (p2[1] - p0[1]) * tension}, ${p2[0] - (p3[0] - p1[0]) * tension} ${p2[1] - (p3[1] - p1[1]) * tension}, ${p2[0]} ${p2[1]}`;
  }

  const lastPt = points[points.length - 1];
  const areaD = `${pathD} L ${gx(lastPt.x)} ${gy(yMin)} L ${gx(0)} ${gy(yMin)} Z`;
  svg.appendChild(el('path', { d: areaD, fill: 'url(#eq-fill)' }));
  svg.appendChild(el('path', { d: pathD, fill: 'none', stroke: clr, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

  svg.appendChild(el('circle', { cx: gx(0), cy: gy(0), r: 4, fill: '#fff', stroke: clr, 'stroke-width': 2 }));
  svg.appendChild(el('circle', { cx: gx(lastPt.x), cy: gy(lastPt.y), r: 5, fill: '#fff', stroke: clr, 'stroke-width': 2.5, filter: 'url(#eq-glow)' }));

  const endLbl = el('text', { x: gx(lastPt.x), y: gy(lastPt.y) - 12, 'text-anchor': 'middle', fill: clr, 'font-size': 11, 'font-family': 'DM Mono, monospace', 'font-weight': 700 });
  endLbl.textContent = `${lastPt.y >= 0 ? '+' : ''}${lastPt.y.toFixed(2)}%`;
  svg.appendChild(endLbl);

  let tooltip = document.getElementById('db-chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'db-chart-tooltip';
    tooltip.className = 'chart-tooltip';
    document.querySelector('.db-chart-container').appendChild(tooltip);
  }

  const hoverLine = el('line', { x1: 0, y1: mt, x2: 0, y2: mt + ch, stroke: '#b0bab5', 'stroke-width': 1, 'stroke-dasharray': '3 2', opacity: 0 });
  const hoverDot = el('circle', { cx: 0, cy: 0, r: 5, fill: clr, stroke: '#fff', 'stroke-width': 2, opacity: 0 });
  svg.appendChild(hoverLine);
  svg.appendChild(hoverDot);

  const hoverRect = el('rect', { x: ml, y: mt, width: cw, height: ch, fill: 'transparent', cursor: 'crosshair' });
  hoverRect.addEventListener('mousemove', e => {
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * w;
    const idx = Math.max(0, Math.min(Math.round(((mx - ml) / cw) * total), points.length - 1));
    const pt = points[idx];
    const px = gx(pt.x), py = gy(pt.y);
    hoverLine.setAttribute('x1', px); hoverLine.setAttribute('x2', px); hoverLine.setAttribute('opacity', 1);
    hoverDot.setAttribute('cx', px); hoverDot.setAttribute('cy', py); hoverDot.setAttribute('opacity', 1);
    tooltip.style.display = 'block';
    tooltip.innerHTML = `<strong>${pt.label}</strong><br/>${pt.y >= 0 ? '+' : ''}${pt.y.toFixed(2)}%<br/><small>${pt.detail}</small>`;
    const tipX = (px / w) * rect.width;
    const tipY = (py / h) * rect.height;
    tooltip.style.left = `${tipX}px`;
    tooltip.style.top = `${tipY}px`;
  });
  hoverRect.addEventListener('mouseleave', () => {
    hoverLine.setAttribute('opacity', 0);
    hoverDot.setAttribute('opacity', 0);
    tooltip.style.display = 'none';
  });
  svg.appendChild(hoverRect);
}

function renderDashboard() {
  const data = window.lastDashboardData || getMockDemoData();
  const currentValue = data.portfolio.value || 3184620;     // holdings value + cash
  const cash = data.portfolio.cash || 0;                     // cash / fund balance
  const equityValue = data.portfolio.equityValue || (currentValue - cash); // holdings current val
  const unrealizedPnlFromAPI = data.portfolio.pnl || 0;    // unrealized P&L on current holdings

  // === 3-STEP FORMULA ===
  // 1. Current Value = Holdings Value + Cash  (from Zerodha API)
  // 2. Total Profit  = Realized P&L (from tradebook CSV) + Unrealized P&L (from holdings API)
  // 3. Investment    = Current Value − Total Profit  (net pay-in minus pay-out)

  const allTrades = getTradeHistory(data);
  const trades = filterByRange(allTrades, currentRange);
  const hasTradebook = tradebookData && tradebookData.loaded;
  const realizedPnl = hasTradebook ? (tradebookData.realizedPnl || 0) : 0;
  const unrealizedPnl = unrealizedPnlFromAPI;

  const totalProfit = Math.round(realizedPnl + unrealizedPnl);
  const investment = Math.round(currentValue - totalProfit);
  const returnPercent = investment > 0 ? (totalProfit / investment * 100) : 0;

  const totalTrades = trades.length;
  const winningTrades = trades.filter(t => t.netPnl > 0);
  const winRate = totalTrades ? (winningTrades.length / totalTrades * 100) : 0;

  // Render the 4 dashboard top cards
  document.getElementById('db-investment').textContent = currency.format(investment);
  document.getElementById('db-investment-label').textContent = 'Net deposits (Pay-in − Pay-out)';

  document.getElementById('db-profit').textContent = signed(totalProfit, currency.format);
  document.getElementById('db-profit').className = totalProfit >= 0 ? 'positive' : 'negative';
  document.getElementById('db-profit-percent').textContent = signed(returnPercent, val => `${val.toFixed(2)}%`);
  document.getElementById('db-profit-percent').className = totalProfit >= 0 ? 'positive' : 'negative';

  document.getElementById('db-current-value').textContent = currency.format(currentValue);
  document.getElementById('db-current-value-label').textContent = `Holdings ${shortCurrency(equityValue)} + Cash ${shortCurrency(cash)}`;

  document.getElementById('db-win-rate').textContent = `${winRate.toFixed(1)}%`;
  document.getElementById('db-win-rate-label').textContent = `of ${totalTrades} trades`;

  // Note: Overview page stat cards (invested-value, return-percent, total-return, day-card)
  // are updated exclusively by loadLiveDashboard() from the Kite API.
  // renderDashboard() must NOT touch those elements.

  const startingCapital = investment;


  // Render Monthly Table
  const tableBody = document.getElementById('db-monthly-body');
  if (tableBody) {
    tableBody.innerHTML = '';
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let prevCap = startingCapital;

    // No fabricated capital additions/withdrawals
    const additions = {};

    for (let m = 1; m <= 12; m++) {
      const monthTrades = trades.filter(t => t.month === m);
      const startCap = prevCap;
      const added = additions[m] || 0;

      let pnl = 0;
      let charges = 0;
      let tradesCount = 0;
      let winPercent = 0;
      let avgGain = 0;
      let avgLoss = 0;
      let avgRR = 0;
      let bestImpact = 0;
      let worstImpact = 0;
      let avgDays = 0;

      if (monthTrades.length > 0) {
        tradesCount = monthTrades.length;
        pnl = monthTrades.reduce((sum, t) => sum + t.pnl, 0);
        charges = monthTrades.reduce((sum, t) => sum + t.charges, 0);

        const wins = monthTrades.filter(t => t.netPnl > 0);
        const losses = monthTrades.filter(t => t.netPnl <= 0);

        winPercent = (wins.length / tradesCount) * 100;

        const gainPctVals = wins.map(t => t.pnlPercent);
        const lossPctVals = losses.map(t => t.pnlPercent);

        avgGain = gainPctVals.length ? (gainPctVals.reduce((a, b) => a + b, 0) / gainPctVals.length) : 0;
        avgLoss = lossPctVals.length ? (lossPctVals.reduce((a, b) => a + b, 0) / lossPctVals.length) : 0;
        avgRR = avgLoss ? (avgGain / Math.abs(avgLoss)) : 0;

        const impacts = monthTrades.map(t => (t.netPnl / startCap) * 100);
        bestImpact = Math.max(...impacts);
        worstImpact = Math.min(...impacts);

        avgDays = monthTrades.reduce((sum, t) => sum + t.holdingDays, 0) / tradesCount;
      }

      const netMonthPnl = pnl - charges;
      const finalCap = startCap + netMonthPnl + added;
      const monthPnlPercent = startCap ? (netMonthPnl / startCap * 100) : 0;

      prevCap = finalCap;

      const showPnl = tradesCount > 0 ? signed(netMonthPnl, currency.format) : '—';
      const showCharges = tradesCount > 0 ? currency.format(charges) : '—';
      const showPnlPct = tradesCount > 0 ? signed(monthPnlPercent, v => `${v.toFixed(2)}%`) : '—';
      const showWinRate = tradesCount > 0 ? `${winPercent.toFixed(1)}%` : '—';
      const showAvgGain = tradesCount > 0 && avgGain ? `${avgGain.toFixed(2)}%` : '—';
      const showAvgLoss = tradesCount > 0 && avgLoss ? `${avgLoss.toFixed(2)}%` : '—';
      const showRR = tradesCount > 0 && avgRR ? avgRR.toFixed(2) : '—';
      const showBestImpact = tradesCount > 0 ? signed(bestImpact, v => `${v.toFixed(2)}%`) : '—';
      const showWorstImpact = tradesCount > 0 ? signed(worstImpact, v => `${v.toFixed(2)}%`) : '—';
      const showAvgDays = tradesCount > 0 ? Math.round(avgDays) : '—';

      const pnlClass = netMonthPnl > 0 ? 'positive' : (netMonthPnl < 0 ? 'negative' : '');
      const pnlPctClass = monthPnlPercent > 0 ? 'positive' : (monthPnlPercent < 0 ? 'negative' : '');

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${monthNames[m - 1]}</td>
        <td>${currency.format(startCap)}</td>
        <td>${added !== 0 ? signed(added, currency.format) : '—'}</td>
        <td class="${pnlClass}">${showPnl}</td>
        <td>${showCharges}</td>
        <td class="${pnlPctClass}">${showPnlPct}</td>
        <td>${currency.format(finalCap)}</td>
        <td>${tradesCount || '—'}</td>
        <td>${showWinRate}</td>
        <td class="positive">${showAvgGain}</td>
        <td class="negative">${showAvgLoss}</td>
        <td>${showRR}</td>
        <td class="positive">${showBestImpact}</td>
        <td class="negative">${showWorstImpact}</td>
        <td>${showAvgDays}</td>
      `;
      tableBody.appendChild(tr);
    }
  }

  // Update Year P/L Summary Badge
  document.getElementById('db-year-pnl-summary').textContent = `Year P/L: ${signed(returnPercent, v => `${v.toFixed(2)}%`)}`;

  // Last N Stats logic
  const renderStatsN = () => {
    const nCountInput = document.getElementById('db-n-count');
    const N = Math.min(Math.max(parseInt(nCountInput.value) || 20, 1), totalTrades);

    const lastNTrades = trades.slice(-N);
    const nTotal = lastNTrades.length;
    const nWins = lastNTrades.filter(t => t.netPnl > 0);
    const nLosses = lastNTrades.filter(t => t.netPnl <= 0);

    const nWinRate = nTotal ? (nWins.length / nTotal * 100) : 0;
    const nAvgGain = nWins.length ? (nWins.reduce((sum, t) => sum + t.pnlPercent, 0) / nWins.length) : 0;
    const nAvgLoss = nLosses.length ? (nLosses.reduce((sum, t) => sum + t.pnlPercent, 0) / nLosses.length) : 0;
    const nAvgPosSize = 4.67;
    const nAvgDays = nTotal ? (lastNTrades.reduce((sum, t) => sum + t.holdingDays, 0) / nTotal) : 0;
    const nAvgRMultiple = nTotal ? (lastNTrades.reduce((sum, t) => sum + t.rMultiple, 0) / nTotal) : 0;

    document.getElementById('db-n-win-percent').textContent = `${nWinRate.toFixed(1)}%`;
    document.getElementById('db-n-avg-gain').textContent = `${nAvgGain.toFixed(2)}%`;
    document.getElementById('db-n-avg-loss').textContent = `${nAvgLoss.toFixed(2)}%`;
    document.getElementById('db-n-avg-pos-size').textContent = `${nAvgPosSize.toFixed(2)}%`;
    document.getElementById('db-n-avg-days').textContent = Math.round(nAvgDays);
    document.getElementById('db-n-r-multiple').textContent = nAvgRMultiple.toFixed(2);
    document.getElementById('db-n-r-multiple').className = nAvgRMultiple >= 0 ? 'positive' : 'negative';
  };

  const nCountInput = document.getElementById('db-n-count');
  nCountInput.removeEventListener('input', renderStatsN);
  nCountInput.addEventListener('input', renderStatsN);
  renderStatsN();

  // Key Performance Indicators
  const overallAvgR = totalTrades ? (trades.reduce((sum, t) => sum + t.rMultiple, 0) / totalTrades) : 0;
  const openPositions = data.holdings ? data.holdings.length : 0;
  const cashWeight = currentValue ? (cash / currentValue) * 100 : 0;
  const openHeat = openPositions * 1.62;

  document.getElementById('db-overall-avg-r').textContent = overallAvgR.toFixed(2);
  document.getElementById('db-overall-avg-r').className = overallAvgR >= 0 ? 'positive' : 'negative';
  document.getElementById('db-overall-open-positions').textContent = openPositions;
  document.getElementById('db-overall-cash-weight').textContent = `${cashWeight.toFixed(1)}%`;
  document.getElementById('db-overall-open-heat').textContent = `${openHeat.toFixed(2)}%`;

  // Best & Worst Trades Records — only shown when tradebook is loaded
  if (totalTrades > 0) {
    const bestMove = trades.reduce((best, t) => t.pnlPercent > best.pnlPercent ? t : best, trades[0]);
    const worstMove = trades.reduce((worst, t) => t.pnlPercent < worst.pnlPercent ? t : worst, trades[0]);
    const bestImpact = trades.reduce((best, t) => (t.netPnl / t.capital) > (best.netPnl / best.capital) ? t : best, trades[0]);
    const worstImpact = trades.reduce((worst, t) => (t.netPnl / t.capital) < (worst.netPnl / worst.capital) ? t : worst, trades[0]);

    document.getElementById('db-best-move-percent').textContent = `+${bestMove.pnlPercent.toFixed(2)}%`;
    document.getElementById('db-best-move-desc').textContent = `${bestMove.symbol} · ${new Date(bestMove.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;

    document.getElementById('db-worst-move-percent').textContent = `${worstMove.pnlPercent.toFixed(2)}%`;
    document.getElementById('db-worst-move-desc').textContent = `${worstMove.symbol} · ${new Date(worstMove.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;

    const bestImpactPct = (bestImpact.netPnl / bestImpact.capital) * 100;
    document.getElementById('db-best-impact-percent').textContent = `+${bestImpactPct.toFixed(2)}%`;
    document.getElementById('db-best-impact-desc').textContent = `${bestImpact.symbol} · ${new Date(bestImpact.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;

    const worstImpactPct = (worstImpact.netPnl / worstImpact.capital) * 100;
    document.getElementById('db-worst-impact-percent').textContent = `${worstImpactPct.toFixed(2)}%`;
    document.getElementById('db-worst-impact-desc').textContent = `${worstImpact.symbol} · ${new Date(worstImpact.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  } else {
    // No tradebook yet — show placeholder
    ['db-best-move-percent', 'db-best-impact-percent'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
    ['db-worst-move-percent', 'db-worst-impact-percent'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
    ['db-best-move-desc', 'db-worst-move-desc', 'db-best-impact-desc', 'db-worst-impact-desc'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'Upload tradebook to see records'; });
  }

  drawEquityChart(trades, startingCapital);
  loadAnalytics();
}

// ── Analytics ────────────────────────────────────────────────────────────────
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

async function loadAnalytics() {
  try {
    const res = await fetch('/api/tradebook/analytics');
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.available) return;
    renderAnalyticsPanels(data);
  } catch { /* analytics unavailable */ }
}

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function colorCode(id, pos) { const el = document.getElementById(id); if (el) el.className = pos ? 'positive' : 'negative'; }

function renderAnalyticsPanels(a) {
  const section = document.getElementById('db-analytics-section');
  if (!section) return;
  section.hidden = false;

  setText('db-profit-factor', a.profitFactor >= 999 ? '∞' : a.profitFactor.toFixed(2));
  setText('db-expectancy', currency.format(a.expectancy));
  setText('db-payoff-ratio', a.payoffRatio.toFixed(2));
  setText('db-kelly', `${a.kellyCriterion.toFixed(1)}%`);
  setText('db-sharpe', a.sharpe.toFixed(2));
  setText('db-recovery', a.recoveryFactor.toFixed(2));

  colorCode('db-profit-factor', a.profitFactor >= 1);
  colorCode('db-expectancy', a.expectancy >= 0);
  colorCode('db-kelly', a.kellyCriterion >= 0);
  colorCode('db-sharpe', a.sharpe >= 0);

  const streak = a.streaks.current;
  const streakEl = document.getElementById('db-current-streak');
  if (streakEl) {
    streakEl.textContent = streak > 0 ? `${streak}W` : streak < 0 ? `${Math.abs(streak)}L` : '—';
    streakEl.className = `streak-value ${streak > 0 ? 'positive' : streak < 0 ? 'negative' : ''}`;
  }
  setText('db-max-win-streak', `${a.streaks.maxWin} trades`);
  setText('db-max-loss-streak', `${a.streaks.maxLoss} trades`);
  setText('db-avg-win-hold', `${a.holdingPeriod.avgWin} days`);
  setText('db-avg-loss-hold', `${a.holdingPeriod.avgLoss} days`);
  setText('db-gross-pl', `${shortCurrency(a.summary.grossProfit)} / ${shortCurrency(a.summary.grossLoss)}`);
  setText('db-max-dd-badge', `Max DD: ${a.drawdown.max.toFixed(1)}%`);

  drawDrawdownChart(a.drawdown.series);
  drawDistributionChart(a.distribution);
  drawDayOfWeekChart(a.dayOfWeek);
  renderCalendarHeatmap(a.calendarData);
}

function drawDrawdownChart(series) {
  const svg = document.getElementById('db-drawdown-chart');
  if (!svg || !series.length) return;
  svg.innerHTML = '';
  const w = 500, h = 200, ml = 45, mr = 10, mt = 10, mb = 25;
  const cw = w - ml - mr, ch = h - mt - mb;
  const maxDD = Math.max(...series.map(s => s.dd), 1);
  const yMax = Math.ceil(maxDD / 5) * 5 || 5;

  const defs = svgEl('defs');
  defs.innerHTML = '<linearGradient id="dd-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#c55550" stop-opacity="0.25"/><stop offset="100%" stop-color="#c55550" stop-opacity="0.02"/></linearGradient>';
  svg.appendChild(defs);

  for (let i = 0; i <= 4; i++) {
    const y = mt + (i / 4) * ch;
    svg.appendChild(svgEl('line', { x1: ml, y1: y, x2: w - mr, y2: y, stroke: '#ebeeeb', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
    const t = svgEl('text', { x: ml - 8, y: y + 3, 'text-anchor': 'end', fill: '#74817b', 'font-size': 9, 'font-family': 'DM Mono, monospace' });
    t.textContent = `-${((i / 4) * yMax).toFixed(0)}%`;
    svg.appendChild(t);
  }

  const getX = i => ml + (i / (series.length - 1 || 1)) * cw;
  const getY = dd => mt + (dd / yMax) * ch;
  const pathD = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(s.dd)}`).join(' ');

  svg.appendChild(svgEl('path', { d: `${pathD} L ${getX(series.length - 1)} ${mt + ch} L ${getX(0)} ${mt + ch} Z`, fill: 'url(#dd-fill)' }));
  svg.appendChild(svgEl('path', { d: pathD, fill: 'none', stroke: '#c55550', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
}

function drawDistributionChart(distribution) {
  const svg = document.getElementById('db-distribution-chart');
  if (!svg || !distribution.length) return;
  svg.innerHTML = '';
  const w = 500, h = 220, ml = 10, mr = 10, mt = 15, mb = 50;
  const cw = w - ml - mr, ch = h - mt - mb;
  const maxCount = Math.max(...distribution.map(d => d.count), 1);
  const barW = cw / distribution.length - 6;

  distribution.forEach((d, i) => {
    const x = ml + i * (cw / distribution.length) + 3;
    const barH = (d.count / maxCount) * ch;
    const y = mt + ch - barH;
    const isLoss = d.label.includes('-') || d.label.startsWith('<');
    svg.appendChild(svgEl('rect', { x, y, width: barW, height: Math.max(barH, 2), rx: 3, fill: isLoss ? '#e8b4b2' : '#a8efd0' }));
    if (d.count > 0) {
      const t = svgEl('text', { x: x + barW / 2, y: y - 5, 'text-anchor': 'middle', fill: '#424c47', 'font-size': 10, 'font-family': 'Manrope, sans-serif', 'font-weight': 600 });
      t.textContent = d.count;
      svg.appendChild(t);
    }
    const lbl = svgEl('text', { x: x + barW / 2, y: h - mb + 14, 'text-anchor': 'middle', fill: '#74817b', 'font-size': 8, 'font-family': 'DM Mono, monospace' });
    lbl.textContent = d.label;
    svg.appendChild(lbl);
  });
}

function drawDayOfWeekChart(dayOfWeek) {
  const svg = document.getElementById('db-dow-chart');
  if (!svg) return;
  svg.innerHTML = '';
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const data = days.map(d => ({ day: d, ...(dayOfWeek[d] || { pnl: 0, count: 0, wins: 0 }) }));
  const w = 400, h = 200, ml = 10, mr = 10, mt = 20, mb = 35;
  const cw = w - ml - mr, ch = h - mt - mb;
  const maxAbs = Math.max(...data.map(d => Math.abs(d.pnl)), 1);
  const midY = mt + ch / 2;

  svg.appendChild(svgEl('line', { x1: ml, y1: midY, x2: w - mr, y2: midY, stroke: '#d0d5d0', 'stroke-width': 1 }));
  const barW = cw / days.length - 16;

  data.forEach((d, i) => {
    const x = ml + i * (cw / days.length) + 8;
    const barH = Math.abs(d.pnl / maxAbs) * (ch / 2);
    const y = d.pnl >= 0 ? midY - barH : midY;
    svg.appendChild(svgEl('rect', { x, y, width: barW, height: Math.max(barH, 1), rx: 4, fill: d.pnl >= 0 ? '#1c9167' : '#c55550' }));
    const vt = svgEl('text', { x: x + barW / 2, y: d.pnl >= 0 ? y - 6 : y + barH + 14, 'text-anchor': 'middle', fill: '#424c47', 'font-size': 9, 'font-family': 'DM Mono, monospace' });
    vt.textContent = d.count > 0 ? shortCurrency(d.pnl) : '—';
    svg.appendChild(vt);
    const lt = svgEl('text', { x: x + barW / 2, y: h - 8, 'text-anchor': 'middle', fill: '#74817b', 'font-size': 10, 'font-family': 'Manrope, sans-serif', 'font-weight': 600 });
    lt.textContent = d.day;
    svg.appendChild(lt);
  });
}

function renderCalendarHeatmap(calendarData) {
  const container = document.getElementById('db-calendar-heatmap');
  if (!container) return;
  container.innerHTML = '';
  const dates = Object.keys(calendarData).sort();
  if (!dates.length) {
    container.innerHTML = '<p class="muted" style="text-align:center;padding:20px">Upload tradebook to see trade calendar</p>';
    return;
  }
  const months = {};
  dates.forEach(d => { const key = d.substring(0, 7); if (!months[key]) months[key] = {}; months[key][d] = calendarData[d]; });
  const mNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  Object.entries(months).forEach(([monthKey, days]) => {
    const [year, mNum] = monthKey.split('-');
    const monthDiv = document.createElement('div');
    monthDiv.className = 'cal-month';
    const header = document.createElement('div');
    header.className = 'cal-month-header';
    header.textContent = `${mNames[parseInt(mNum) - 1]} ${year}`;
    monthDiv.appendChild(header);
    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(d => { const dh = document.createElement('div'); dh.className = 'cal-day-header'; dh.textContent = d; grid.appendChild(dh); });
    let startDay = new Date(parseInt(year), parseInt(mNum) - 1, 1).getDay() - 1;
    if (startDay < 0) startDay = 6;
    for (let i = 0; i < startDay; i++) { const e = document.createElement('div'); e.className = 'cal-cell empty'; grid.appendChild(e); }
    const daysInMonth = new Date(parseInt(year), parseInt(mNum), 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${mNum}-${String(day).padStart(2, '0')}`;
      const cell = document.createElement('div');
      const data = days[dateStr];
      if (data) {
        const intensity = Math.min(Math.abs(data.pnl) / 5000, 1);
        cell.className = `cal-cell ${data.pnl >= 0 ? 'cal-positive' : 'cal-negative'}`;
        cell.style.opacity = 0.3 + intensity * 0.7;
        cell.title = `${dateStr}: ${data.pnl >= 0 ? '+' : ''}₹${Math.round(data.pnl)} (${data.count} trade${data.count > 1 ? 's' : ''})`;
      } else { cell.className = 'cal-cell'; }
      cell.textContent = day;
      grid.appendChild(cell);
    }
    monthDiv.appendChild(grid);
    container.appendChild(monthDiv);
  });
}


async function loadLiveDashboard() {
  try {
    const response = await fetch('/api/dashboard');
    if (!response.ok) {
      // Not connected — leave static placeholder values on Overview
      window.lastDashboardData = getMockDemoData();
      renderAssetAllocation(window.lastDashboardData);
      return;
    }
    const data = await response.json();
    window.lastDashboardData = data;

    const { portfolio } = data;

    // ── Overview Hero ────────────────────────────────────────────────────────
    document.querySelector('#net-worth').textContent = currency.format(portfolio.value);
    document.querySelector('#day-pnl').textContent = signed(portfolio.dayPnl, currency.format);
    document.querySelector('#day-pnl').className = portfolio.dayPnl >= 0 ? 'positive' : 'negative';
    document.querySelector('#day-percent').textContent = 'broker-derived day P&L';
    document.querySelector('#portfolio-status').textContent =
      `${data.profile.name} · ${data.holdings.length} live holdings · refreshed just now`;

    // ── Overview Stats Cards (all from Kite API — no tradebook) ──────────────
    // INVESTED VALUE = cost basis of current holdings (from Kite)
    const investedEl = document.querySelector('#invested-value');
    if (investedEl) investedEl.textContent = currency.format(portfolio.invested);

    // DAY'S P&L card (id="day-card" in the stats grid)
    const dayCardEl = document.querySelector('#day-card');
    const dayCardLabelEl = document.querySelector('#day-card-label');
    if (dayCardEl) {
      dayCardEl.textContent = signed(portfolio.dayPnl, currency.format);
      dayCardEl.className = portfolio.dayPnl >= 0 ? 'positive' : 'negative';
    }
    if (dayCardLabelEl) dayCardLabelEl.textContent = 'broker-derived · today';

    // RETURNS = unrealized P&L % on current holdings (from Kite)
    const totalReturnEl = document.querySelector('#total-return');
    const returnPctEl = document.querySelector('#return-percent');
    const unrealizedReturnPct = portfolio.returnPercent || 0;
    if (totalReturnEl) totalReturnEl.textContent = signed(unrealizedReturnPct, v => `${v.toFixed(2)}%`);
    if (returnPctEl) {
      returnPctEl.textContent = signed(unrealizedReturnPct, v => `${v.toFixed(2)}%`);
      returnPctEl.className = unrealizedReturnPct >= 0 ? 'positive' : 'negative';
    }

    // TOTAL P&L = unrealized P&L amount on current holdings (from Kite)
    const totalPnlEl = document.querySelector('#total-pnl');
    const totalPnlPctEl = document.querySelector('#total-pnl-pct');
    const unrealizedPnlAmt = portfolio.pnl || 0;
    if (totalPnlEl) {
      totalPnlEl.textContent = signed(unrealizedPnlAmt, currency.format);
      totalPnlEl.className = unrealizedPnlAmt >= 0 ? 'positive' : 'negative';
    }
    if (totalPnlPctEl) {
      totalPnlPctEl.textContent = `${signed(unrealizedReturnPct, v => `${v.toFixed(2)}%`)} · unrealised`;
      totalPnlPctEl.className = unrealizedPnlAmt >= 0 ? 'positive' : 'negative';
    }

    // Connect button
    document.querySelector('#connect-broker').textContent = '● Zerodha connected';
    document.querySelector('#connect-broker').classList.add('connected');

    renderHoldings(data.holdings, portfolio.value);
    renderLivePanels(data);
    renderExtendedPanels(data);
    renderAssetAllocation(data);
    renderTradebookBanner();
    if (!window._hasSynced) { window._hasSynced = true; syncTradesFromKite(); }
  } catch {
    window.lastDashboardData = getMockDemoData();
    renderAssetAllocation(window.lastDashboardData);
  }
}

const connectBtn = document.querySelector('#connect-broker');
if (connectBtn) {
  connectBtn.addEventListener('click', () => window.location.assign('/api/auth/kite'));
}

// Check URL Hash on load/change to direct user to Dashboard if bookmarked
const checkHash = () => {
  if (window.location.hash === '#dashboard') {
    const dbLink = document.querySelector('a[href="#dashboard"]');
    if (dbLink) dbLink.click();
  }
};
window.addEventListener('hashchange', checkHash);

// Run initial loading flow — load tradebook and dashboard data in parallel
// renderDashboard() is only called after BOTH are resolved so the tradebook
// feeds into the P&L calculations correctly.
Promise.all([loadTradebook(), loadLiveDashboard()]).then(() => {
  if (window.lastDashboardData) renderDashboard();
});
setTimeout(checkHash, 100);
