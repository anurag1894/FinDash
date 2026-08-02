import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
if (existsSync(join(root, '.env.local'))) for (const line of readFileSync(join(root, '.env.local'), 'utf8').split(/\r?\n/)) { const match = line.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2]; }
const { KITE_API_KEY, KITE_API_SECRET, PORT = '4173', APP_PASSWORD, SESSION_SECRET = randomBytes(32).toString('hex'), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
const sessions = new Map(); // sessionId → { user: {email,name,picture}, kiteAccessToken?, kiteExpiresAt? }
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
const secHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...secHeaders, ...headers }); res.end(JSON.stringify(data)); };
const readCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
const kite = async (path, token, options = {}) => { const response = await fetch(`https://api.kite.trade${path}`, { ...options, headers: { 'X-Kite-Version': '3', Authorization: `token ${KITE_API_KEY}:${token}`, ...options.headers } }); const body = await response.json().catch(() => ({})); if (!response.ok || body.status === 'error') throw new Error(body.message || 'Kite Connect request failed'); return body.data; };
const amount = value => Math.round((value || 0) * 100) / 100;

// ── Authentication ──────────────────────────────────────────────────────────
const loginAttempts = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 900000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 900000; }
    entry.count++;
    loginAttempts.set(ip, entry);
    return entry.count <= 5;
}

function signToken(token) { return createHmac('sha256', SESSION_SECRET).update(token).digest('hex'); }
const _secure = () => process.env.NODE_ENV === 'production' ? ' Secure;' : '';

function makeSessionCookie(token, maxAge = 86400) {
    const signed = `${token}.${signToken(token)}`;
    return `findash_session=${encodeURIComponent(signed)}; HttpOnly;${_secure()} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function makeStateCookie(name, state, maxAge = 600) {
    const sig = createHmac('sha256', SESSION_SECRET).update(state).digest('hex');
    return `${name}=${state}.${sig}; HttpOnly;${_secure()} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function verifyStateCookie(req, name, state) {
    const cookie = readCookies(req)[name] || '';
    const dot = cookie.lastIndexOf('.');
    if (dot <= 0) return false;
    const cookieState = cookie.slice(0, dot), cookieSig = cookie.slice(dot + 1);
    const expected = createHmac('sha256', SESSION_SECRET).update(cookieState).digest('hex');
    if (cookieSig.length !== expected.length) return false;
    try { if (!timingSafeEqual(Buffer.from(cookieSig), Buffer.from(expected))) return false; } catch { return false; }
    return state === cookieState;
}

function getSession(req) {
    const raw = readCookies(req).findash_session;
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const token = raw.slice(0, dot), sig = raw.slice(dot + 1);
    const expected = signToken(token);
    if (sig.length !== expected.length) return null;
    try { if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; } catch { return null; }
    return sessions.get(token) || null;
}

function getSessionId(req) {
    const raw = readCookies(req).findash_session;
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const token = raw.slice(0, dot);
    return sessions.has(token) ? token : null;
}

const LOGIN_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FinDash — Sign in</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Manrope',system-ui,sans-serif;background:#f3f6f3;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.08)}
.logo{font:700 22px 'Manrope',sans-serif;color:#1b2e24;margin-bottom:6px;display:flex;align-items:center;gap:10px}
.logo span{background:#1b2e24;color:#84e2bd;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;font-size:14px;font-weight:800}
.sub{font-size:13px;color:#74817b;margin-bottom:28px}
.google-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px;background:#fff;border:1.5px solid #dce3dc;border-radius:10px;font:600 14px 'Manrope',sans-serif;color:#1b2e24;cursor:pointer;text-decoration:none;transition:background 0.2s,border-color 0.2s}
.google-btn:hover{background:#f8faf8;border-color:#16835d}
.google-btn svg{flex-shrink:0}
.divider{display:flex;align-items:center;gap:12px;margin:24px 0;color:#b0bab5;font-size:11px;text-transform:uppercase;letter-spacing:1px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:#e8ece8}
label{font:600 11px 'DM Mono',monospace;color:#74817b;letter-spacing:0.5px;text-transform:uppercase;display:block;margin-bottom:6px}
input{width:100%;padding:12px 14px;border:1.5px solid #dce3dc;border-radius:10px;font:500 14px 'Manrope',sans-serif;outline:none;transition:border 0.2s}
input:focus{border-color:#16835d}
.pw-btn{width:100%;margin-top:16px;padding:13px;background:#1b2e24;color:#fff;font:600 14px 'Manrope',sans-serif;border:none;border-radius:10px;cursor:pointer;transition:opacity 0.2s}
.pw-btn:hover{opacity:0.85}
.err{color:#c55550;font-size:12px;margin-top:14px;text-align:center;display:none}
.pw-section{display:none}
</style></head><body>
<div class="card">
<div class="logo"><span>F</span> FinDash</div>
<p class="sub">Sign in to access your trading dashboard.</p>
<div id="google-section"></div>
<div id="pw-divider" class="divider" style="display:none">or</div>
<div id="pw-section" style="display:none">
<form method="POST" action="/auth/login">
<label>Password</label>
<input type="password" name="password" autofocus required autocomplete="current-password"/>
<button type="submit" class="pw-btn">Sign in with password</button>
</form>
</div>
<p class="err" id="err"></p>
</div>
<script>
const p=new URLSearchParams(location.search);
if(p.get('error')){const e=document.getElementById('err');e.textContent=p.get('error');e.style.display='block'}
fetch('/auth/config').then(r=>r.json()).then(c=>{
  if(c.google){document.getElementById('google-section').innerHTML='<a href="/auth/google" class="google-btn"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Sign in with Google</a>';}
  if(c.password){document.getElementById('pw-section').style.display='block';if(c.google)document.getElementById('pw-divider').style.display='flex';}
  if(!c.google&&!c.password)location.href='/';
});
</script>
</body></html>`;

function authGuard(req, url) {
    const path = url.pathname;
    if (path === '/auth/login' || path === '/auth/google' || path === '/auth/google/callback' || path === '/auth/config' || path === '/api/auth/kite/callback') return null;
    if (getSession(req)) return null;
    if (!APP_PASSWORD && !GOOGLE_CLIENT_ID) return null;
    return 'login';
}

// ── Tradebook: CSV parser + FIFO P&L engine ──────────────────────────────────
let tradebookCache = null; // { trades, realizedPnl, uploadedAt, filename, source }
const TRADES_HISTORY_FILE = join(root, 'trades-history.json');

function loadTradesHistory() {
    if (!existsSync(TRADES_HISTORY_FILE)) return { trades: [], lastSyncAt: null, syncCount: 0 };
    try { return JSON.parse(readFileSync(TRADES_HISTORY_FILE, 'utf8')); }
    catch { return { trades: [], lastSyncAt: null, syncCount: 0 }; }
}

function saveTradesHistory(history) {
    writeFileSync(TRADES_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

function kiteTradeToRaw(t) {
    const dateStr = (t.fill_timestamp || t.order_timestamp || '').replace(/T.*/, '').split(' ')[0] || '';
    return {
        symbol: t.tradingsymbol, isin: '', date: dateStr, exchange: t.exchange,
        type: (t.transaction_type || '').toLowerCase(), qty: t.quantity, price: t.average_price,
        time: t.fill_timestamp || t.order_timestamp || '', tradeId: t.trade_id, orderId: t.order_id,
    };
}

import XLSX from 'xlsx';



function parseTradebookCsv(csvText) {
    const lines = csvText.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const idx = k => headers.indexOf(k);

    return lines.slice(1).map(line => {
        // handle quoted fields
        const cols = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || line.split(',');
        const clean = cols.map(c => (c || '').replace(/^"|"$/g, '').trim());
        return {
            symbol: clean[idx('symbol')] || clean[0],
            isin: clean[idx('isin')] || clean[1],
            date: clean[idx('trade_date')] || clean[2],
            exchange: clean[idx('exchange')] || clean[3],
            type: (clean[idx('trade_type')] || clean[6] || '').toLowerCase(),
            qty: parseFloat(clean[idx('quantity')] || clean[8] || '0'),
            price: parseFloat(clean[idx('price')] || clean[9] || '0'),
            time: clean[idx('order_execution_time')] || clean[12] || clean[idx('trade_date')] || clean[2],
        };
    }).filter(t => t.symbol && (t.type === 'buy' || t.type === 'sell') && t.qty > 0 && t.price > 0)
        .sort((a, b) => new Date(a.time) - new Date(b.time));
}

function computeFifoPnl(rawTrades) {
    const agg = {};
    for (const t of rawTrades) {
        const key = `${t.symbol}|${t.date}|${t.type}`;
        if (!agg[key]) { agg[key] = { ...t, _tv: t.qty * t.price }; }
        else { agg[key]._tv += t.qty * t.price; agg[key].qty += t.qty; if (t.time < agg[key].time) agg[key].time = t.time; }
    }
    const merged = Object.values(agg).map(g => ({ ...g, price: g.qty > 0 ? g._tv / g.qty : g.price }));
    merged.sort((a, b) => new Date(a.time) - new Date(b.time));

    const inventory = {}; // symbol -> [{qty, price, date}]
    let realizedPnl = 0;
    const completedTrades = [];
    let tradeNo = 0;

    for (const t of merged) {
        const sym = t.symbol;
        if (!inventory[sym]) inventory[sym] = [];

        if (t.type === 'buy') {
            inventory[sym].push({ qty: t.qty, price: t.price, date: t.date });
        } else {
            let remainSell = t.qty;
            let cost = 0;
            let soldQty = 0;
            let entryPrice = 0;
            const entryDate = inventory[sym][0]?.date || t.date;
            while (remainSell > 0.001 && inventory[sym].length > 0) {
                const lot = inventory[sym][0];
                const use = Math.min(remainSell, lot.qty);
                cost += use * lot.price;
                entryPrice = lot.price;
                soldQty += use;
                lot.qty -= use;
                remainSell -= use;
                if (lot.qty < 0.001) inventory[sym].shift();
            }
            if (soldQty > 0) {
                const proceeds = soldQty * t.price;
                const pnl = proceeds - cost;
                const charges = proceeds * 0.001; // ~0.1% brokerage+STT estimate
                const netPnl = pnl - charges;
                realizedPnl += netPnl;
                tradeNo++;
                const d = new Date(t.date);
                completedTrades.push({
                    tradeNo,
                    symbol: sym,
                    exchange: t.exchange,
                    date: entryDate,
                    closeDate: t.date,
                    month: d.getMonth() + 1,
                    qty: Math.round(soldQty),
                    entryPrice: amount(soldQty > 0 ? cost / soldQty : entryPrice),
                    exitPrice: amount(t.price),
                    pnl: amount(pnl),
                    charges: amount(charges),
                    netPnl: amount(netPnl),
                    pnlPercent: amount(cost > 0 ? (pnl / cost * 100) : 0),
                    holdingDays: Math.max(1, Math.round((new Date(t.date) - new Date(entryDate)) / 86400000)),
                });
            }
        }
    }
    return { completedTrades, realizedPnl: amount(realizedPnl) };
}

function computeAdvancedAnalytics(trades) {
    if (!trades || !trades.length) return null;
    const wins = trades.filter(t => t.netPnl > 0);
    const losses = trades.filter(t => t.netPnl <= 0);
    let ws = 0, ls = 0, maxWS = 0, maxLS = 0;
    for (const t of trades) {
        if (t.netPnl > 0) { ws++; ls = 0; if (ws > maxWS) maxWS = ws; }
        else { ls++; ws = 0; if (ls > maxLS) maxLS = ls; }
    }
    let peak = 0, cumPnl = 0, maxDD = 0;
    const ddSeries = [];
    for (const t of trades) {
        cumPnl += t.netPnl;
        if (cumPnl > peak) peak = cumPnl;
        const dd = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0;
        ddSeries.push({ trade: t.tradeNo, dd: amount(dd), cumPnl: amount(cumPnl) });
        if (dd > maxDD) maxDD = dd;
    }
    const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    const winRate = wins.length / trades.length;
    const avgWinAmt = wins.length ? grossProfit / wins.length : 0;
    const avgLossAmt = losses.length ? grossLoss / losses.length : 0;
    const payoffRatio = avgLossAmt > 0 ? avgWinAmt / avgLossAmt : 0;
    const expectancy = (winRate * avgWinAmt) - ((1 - winRate) * avgLossAmt);
    const kelly = payoffRatio > 0 ? (winRate - ((1 - winRate) / payoffRatio)) * 100 : 0;
    const returns = trades.map(t => t.pnlPercent);
    const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
    const sharpe = variance > 0 ? avgReturn / Math.sqrt(variance) : 0;
    const totalNetProfit = trades.reduce((s, t) => s + t.netPnl, 0);
    const maxDDAmt = peak > 0 ? peak * maxDD / 100 : 0;
    const recoveryFactor = maxDDAmt > 0 ? totalNetProfit / maxDDAmt : 0;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayOfWeek = {};
    for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) dayOfWeek[name] = { pnl: 0, count: 0, wins: 0 };
    for (const t of trades) {
        const d = new Date(t.closeDate || t.date);
        const day = dayNames[d.getDay()];
        if (dayOfWeek[day]) { dayOfWeek[day].pnl += t.netPnl; dayOfWeek[day].count++; if (t.netPnl > 0) dayOfWeek[day].wins++; }
    }
    const buckets = [
        { label: '< -10%', min: -Infinity, max: -10 }, { label: '-10 to -5%', min: -10, max: -5 },
        { label: '-5 to -2%', min: -5, max: -2 }, { label: '-2 to 0%', min: -2, max: 0 },
        { label: '0 to 2%', min: 0, max: 2 }, { label: '2 to 5%', min: 2, max: 5 },
        { label: '5 to 10%', min: 5, max: 10 }, { label: '> 10%', min: 10, max: Infinity },
    ];
    const distribution = buckets.map(b => ({ label: b.label, count: trades.filter(t => t.pnlPercent >= b.min && t.pnlPercent < b.max).length }));
    const calendarData = {};
    for (const t of trades) {
        const date = (t.closeDate || t.date || '').split('T')[0];
        if (!date) continue;
        if (!calendarData[date]) calendarData[date] = { pnl: 0, count: 0 };
        calendarData[date].pnl = amount(calendarData[date].pnl + t.netPnl);
        calendarData[date].count++;
    }
    const avgWinHold = wins.length ? Math.round(wins.reduce((s, t) => s + t.holdingDays, 0) / wins.length) : 0;
    const avgLossHold = losses.length ? Math.round(losses.reduce((s, t) => s + t.holdingDays, 0) / losses.length) : 0;
    return {
        streaks: { current: ws > 0 ? ws : -ls, maxWin: maxWS, maxLoss: maxLS },
        drawdown: { max: amount(maxDD), current: amount(ddSeries.length ? ddSeries[ddSeries.length - 1].dd : 0), series: ddSeries },
        profitFactor: amount(profitFactor), expectancy: amount(expectancy), payoffRatio: amount(payoffRatio),
        kellyCriterion: amount(kelly), sharpe: amount(sharpe), recoveryFactor: amount(recoveryFactor),
        dayOfWeek, distribution, calendarData,
        holdingPeriod: { avgWin: avgWinHold, avgLoss: avgLossHold },
        summary: { totalTrades: trades.length, winners: wins.length, losers: losses.length, winRate: amount(winRate * 100), avgWin: amount(avgWinAmt), avgLoss: amount(avgLossAmt), grossProfit: amount(grossProfit), grossLoss: amount(grossLoss), netProfit: amount(totalNetProfit) },
    };
}

function parseTradebookXlsxRows(rows) {
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r && r.includes('Symbol') && (r.includes('Trade Date') || r.includes('trade_date'))) {
            headerIdx = i;
            break;
        }
    }
    if (headerIdx === -1) return [];
    const headers = rows[headerIdx].map(h => String(h || '').trim().toLowerCase());
    const idx = k => headers.indexOf(k);

    return rows.slice(headerIdx + 1).map(r => {
        const sym = r[idx('symbol')];
        if (!sym) return null;
        return {
            symbol: String(sym).trim(),
            isin: String(r[idx('isin')] || '').trim(),
            date: String(r[idx('trade date')] || r[idx('trade_date')] || '').trim(),
            exchange: String(r[idx('exchange')] || '').trim(),
            type: String(r[idx('trade type')] || r[idx('trade_type')] || '').trim().toLowerCase(),
            qty: parseFloat(r[idx('quantity')] || '0'),
            price: parseFloat(r[idx('price')] || '0'),
            time: String(r[idx('order execution time')] || r[idx('order_execution_time')] || r[idx('trade date')] || r[idx('trade_date')] || '').trim(),
        };
    }).filter(t => t && t.symbol && (t.type === 'buy' || t.type === 'sell') && t.qty > 0 && t.price > 0)
        .sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function parsePnlXlsx(filePathOrBuf) {
    const wb = Buffer.isBuffer(filePathOrBuf)
        ? XLSX.read(filePathOrBuf, { type: 'buffer', dense: false })
        : XLSX.readFile(filePathOrBuf, { dense: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // Extract summary totals (rows ~15-18 in the spreadsheet)
    let officialRealizedPnl = 0, officialUnrealizedPnl = 0, charges = 0;
    for (const row of rows) {
        const label = String(row[0] || '').replace(/&amp;/g, '&').trim();
        const val = parseFloat(row[1] || '0') || 0;
        if (label === 'Realized P&L') officialRealizedPnl = val;
        if (label === 'Unrealized P&L') officialUnrealizedPnl = val;
        if (label === 'Charges') charges = val;
    }

    // Find header row: cols = Symbol, ISIN, Quantity, Buy Value, Sell Value, Realized P&L, ...
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (String(r[0] || '').trim() === 'Symbol' && String(r[5] || '').includes('Realized')) {
            headerIdx = i;
            break;
        }
    }

    // Parse per-symbol data rows after header
    const symbolRows = [];
    if (headerIdx >= 0) {
        for (let i = headerIdx + 1; i < rows.length; i++) {
            const r = rows[i];
            const sym = String(r[0] || '').trim();
            if (!sym) continue;
            // Skip summary / footer rows
            if (sym === 'Symbol' || sym.includes('Total') || sym.includes('Disclaimer')) continue;
            const buyValue = parseFloat(r[3] || '0') || 0;
            const sellValue = parseFloat(r[4] || '0') || 0;
            const realizedPnl = parseFloat(r[5] || '0') || 0;
            const pnlPct = parseFloat(r[6] || '0') || 0;
            const openQty = parseFloat(r[8] || '0') || 0;
            const openValue = parseFloat(r[10] || '0') || 0;
            const unrealizedPnl = parseFloat(r[11] || '0') || 0;

            if (buyValue === 0 && sellValue === 0 && openQty === 0) continue;
            symbolRows.push({ sym, buyValue, sellValue, realizedPnl, pnlPct, openQty, openValue, unrealizedPnl });
        }
    }

    // Build a trade record per symbol that had closed positions (Sell Value > 0)
    const completedTrades = symbolRows
        .filter(s => s.sellValue > 0)
        .map((s, idx) => ({
            tradeNo: idx + 1,
            symbol: s.sym,
            exchange: 'NSE',
            date: '', closeDate: '',
            month: 0,   // P&L report has no per-trade dates
            qty: 0,
            entryPrice: amount(s.buyValue),
            exitPrice: amount(s.sellValue),
            pnl: amount(s.realizedPnl),
            charges: 0,
            netPnl: amount(s.realizedPnl),
            pnlPercent: amount(s.pnlPct),
            holdingDays: 0,
        }));

    return {
        completedTrades,
        realizedPnl: amount(officialRealizedPnl),
        charges: amount(charges),
        unrealizedPnl: amount(officialUnrealizedPnl),
        symbolRows,
    };
}

function loadTradebookFromDisk() {
    // Priority 0: Kite API synced trades (persistent across restarts)
    if (existsSync(TRADES_HISTORY_FILE)) {
        try {
            const history = loadTradesHistory();
            const valid = history.trades.filter(t => t.symbol && (t.type === 'buy' || t.type === 'sell') && t.qty > 0 && t.price > 0);
            if (valid.length > 0) {
                const { completedTrades, realizedPnl } = computeFifoPnl(valid);
                tradebookCache = { trades: completedTrades, realizedPnl, uploadedAt: history.lastSyncAt, filename: 'kite-api-sync', rawCount: valid.length, source: 'kite-sync' };
                console.log(`[Kite Sync] Loaded ${valid.length} raw trades → ${completedTrades.length} completed · P&L ₹${realizedPnl}`);
                return;
            }
        } catch (e) { console.warn('[Kite Sync] Failed to load history:', e.message); }
    }

    // Priority 1: Tradebook XLSX (has full chronological execution timestamps)
    const tradebookXlsxFiles = ['tradebook-WMP493-EQ.xlsx'];
    for (const name of tradebookXlsxFiles) {
        const file = join(root, name);
        if (existsSync(file)) {
            try {
                const wb = XLSX.readFile(file, { dense: false });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
                const rawTrades = parseTradebookXlsxRows(rows);
                if (rawTrades.length > 0) {
                    const { completedTrades, realizedPnl } = computeFifoPnl(rawTrades);
                    tradebookCache = { trades: completedTrades, realizedPnl, uploadedAt: new Date().toISOString(), filename: name, rawCount: rawTrades.length, source: 'tradebook-xlsx' };
                    console.log(`[Tradebook XLSX] Loaded "${name}": ${rawTrades.length} raw rows → ${completedTrades.length} completed trades · Realized P&L ₹${realizedPnl}`);
                    return;
                }
            } catch (e) {
                console.warn(`[Tradebook XLSX] Failed to load "${name}":`, e.message);
            }
        }
    }

    // Priority 2: Tradebook CSV
    const candidates = ['tradebook-WMP493-EQ.csv'];
    for (const name of candidates) {
        const file = join(root, name);
        if (existsSync(file)) {
            try {
                const text = readFileSync(file, 'utf8');
                const rawTrades = parseTradebookCsv(text);
                const { completedTrades, realizedPnl } = computeFifoPnl(rawTrades);
                tradebookCache = { trades: completedTrades, realizedPnl, uploadedAt: new Date().toISOString(), filename: name, rawCount: rawTrades.length, source: 'tradebook-csv' };
                console.log(`[Tradebook CSV] Loaded "${name}": ${rawTrades.length} raw rows → ${completedTrades.length} completed trades · Realized P&L ₹${realizedPnl}`);
                return;
            } catch (e) {
                console.warn(`[Tradebook CSV] Failed to load "${name}":`, e.message);
            }
        }
    }

    // Priority 3: P&L report XLSX (fallback if no tradebooks exist)
    const pnlFiles = ['pnl-WMP493.xlsx'];
    for (const name of pnlFiles) {
        const file = join(root, name);
        if (existsSync(file)) {
            parsePnlXlsx(file).then(result => {
                tradebookCache = {
                    trades: result.completedTrades,
                    realizedPnl: result.realizedPnl,
                    charges: result.charges,
                    unrealizedPnl: result.unrealizedPnl,
                    uploadedAt: new Date().toISOString(),
                    filename: name,
                    rawCount: result.symbolRows.length,
                    source: 'pnl-report',
                };
                console.log(`[P&L Report] Loaded "${name}": ${result.symbolRows.length} symbols · Realized P&L ₹${result.realizedPnl} · Unrealized ₹${result.unrealizedPnl}`);
            }).catch(e => console.warn(`[P&L Report] Failed to parse "${name}":`, e.message));
            return;
        }
    }
}
loadTradebookFromDisk();

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function extractFileFromMultipart(body, boundary) {
    const sep = Buffer.from('--' + boundary);
    const parts = [];
    let start = 0;
    while (true) {
        const idx = body.indexOf(sep, start);
        if (idx === -1) break;
        const end = body.indexOf(sep, idx + sep.length);
        if (end === -1) break;
        parts.push(body.slice(idx + sep.length, end));
        start = end;
    }
    for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        const isFile = headers.includes('filename=');
        if (!isFile) continue;
        const fnMatch = headers.match(/filename="([^"]+)"/);
        const filename = fnMatch ? fnMatch[1] : 'file.bin';
        const fileData = part.slice(headerEnd + 4, part.length - 2);
        return { filename, data: fileData };
    }
    return null;
}

// ── Dashboard builder ─────────────────────────────────────────────────────────
function getDashboard(holdings, positions, margins, orders, profile) {
    const rows = holdings.map(h => {
        const qty = (h.quantity || 0) + (h.t1_quantity || 0);
        return { ...h, totalQty: qty };
    }).filter(h => h.totalQty > 0).map(h => {
        const invested = h.average_price * h.totalQty, value = h.last_price * h.totalQty, pnl = (h.last_price - h.average_price) * h.totalQty;
        return { symbol: h.tradingsymbol, exchange: h.exchange, quantity: h.totalQty, averagePrice: amount(h.average_price), lastPrice: amount(h.last_price), value: amount(value), invested: amount(invested), pnl: amount(pnl), dayPnl: amount((h.day_change || 0) * h.totalQty), dayChangePercent: amount(h.day_change_percentage || 0) };
    }).sort((a, b) => b.value - a.value);

    const openPositions = (positions.net || []).filter(p => p.quantity !== 0).map(p => ({ symbol: p.tradingsymbol, exchange: p.exchange, quantity: p.quantity, lastPrice: amount(p.last_price), pnl: amount(p.pnl), m2m: amount(p.m2m || 0), product: p.product }));
    const invested = rows.reduce((s, h) => s + h.invested, 0);
    const equityValue = rows.reduce((s, h) => s + h.value, 0);
    const unrealizedPnl = rows.reduce((s, h) => s + h.pnl, 0);
    const dayPnl = rows.reduce((s, h) => s + h.dayPnl, 0) + openPositions.reduce((s, p) => s + p.m2m, 0);
    const cash = Number(margins.equity?.available?.live_balance || margins.equity?.available?.opening_balance || margins.equity?.available?.cash || 0);
    const value = equityValue + cash;
    const topWeight = value ? (rows[0]?.value || 0) / value * 100 : 0;
    const positive = rows.filter(h => h.pnl >= 0).length;

    return {
        connected: true,
        profile: { name: profile.user_name, broker: profile.broker },
        portfolio: { invested: amount(invested), value: amount(value), equityValue: amount(equityValue), cash: amount(cash), pnl: amount(unrealizedPnl), dayPnl: amount(dayPnl), returnPercent: invested ? amount(unrealizedPnl / invested * 100) : 0, topWeight: amount(topWeight), holdingCount: rows.length },
        holdings: rows.slice(0, 20),
        positions: openPositions,
        orders: (orders || []).slice(0, 8),
        allocation: { equity: amount(equityValue), cash: amount(cash), derivatives: amount(openPositions.reduce((s, p) => s + Math.abs(p.lastPrice * p.quantity), 0)) },
        attribution: rows.slice(0, 5).map(h => ({ symbol: h.symbol, pnl: h.pnl, contribution: unrealizedPnl ? h.pnl / unrealizedPnl * 100 : 0 })),
        risk: { concentration: topWeight > 25 ? 'High' : topWeight > 15 ? 'Moderate' : 'Low', topWeight: amount(topWeight), openPositions: openPositions.length, winners: positive, losers: rows.length - positive },
        generatedAt: new Date().toISOString(),
    };
}

// ── HTTP handler ─────────────────────────────────────────────────────────────
async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ── Auth config (tells login page which methods are available) ────────────
    if (url.pathname === '/auth/config') return json(res, 200, { google: Boolean(GOOGLE_CLIENT_ID), password: Boolean(APP_PASSWORD) });

    // ── Login page ──────────────────────────────────────────────────────────
    if (url.pathname === '/auth/login' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...secHeaders });
        return res.end(LOGIN_PAGE);
    }

    // ── Password login (fallback) ───────────────────────────────────────────
    if (url.pathname === '/auth/login' && req.method === 'POST') {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
        if (!checkRateLimit(ip)) { res.writeHead(302, { Location: '/auth/login?error=Too+many+attempts.+Try+again+in+15+minutes.' }); return res.end(); }
        const body = await readBody(req);
        const password = new URLSearchParams(body.toString()).get('password') || '';
        if (!APP_PASSWORD || password !== APP_PASSWORD) { res.writeHead(302, { Location: '/auth/login?error=Invalid+password.' }); return res.end(); }
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { user: { email: 'admin', name: 'Admin' }, kiteAccessToken: null, kiteExpiresAt: null });
        res.writeHead(302, { Location: '/', 'Set-Cookie': makeSessionCookie(token) });
        return res.end();
    }

    // ── Google OAuth ────────────────────────────────────────────────────────
    if (url.pathname === '/auth/google' && req.method === 'GET') {
        if (!GOOGLE_CLIENT_ID) return json(res, 500, { error: 'Google OAuth is not configured.' });
        const state = randomBytes(24).toString('hex');
        const redirectUri = process.env.GOOGLE_REDIRECT_URL || `https://${req.headers.host}/auth/google/callback`;
        const gUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        gUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
        gUrl.searchParams.set('redirect_uri', redirectUri);
        gUrl.searchParams.set('response_type', 'code');
        gUrl.searchParams.set('scope', 'email profile');
        gUrl.searchParams.set('state', state);
        gUrl.searchParams.set('prompt', 'select_account');
        res.writeHead(302, { Location: gUrl.toString(), 'Set-Cookie': makeStateCookie('google_state', state) });
        return res.end();
    }

    if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
        const code = url.searchParams.get('code'), state = url.searchParams.get('state');
        if (!code || !state || !verifyStateCookie(req, 'google_state', state)) {
            res.writeHead(302, { Location: '/auth/login?error=Google+sign-in+failed.+Please+try+again.' });
            return res.end();
        }
        try {
            const redirectUri = process.env.GOOGLE_REDIRECT_URL || `https://${req.headers.host}/auth/google/callback`;
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
            });
            const tokenData = await tokenRes.json();
            if (!tokenRes.ok) throw new Error(tokenData.error_description || 'Token exchange failed');
            const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
            const userInfo = await userRes.json();
            if (!userRes.ok) throw new Error('Failed to get user info');
            const sessionId = randomBytes(32).toString('hex');
            sessions.set(sessionId, { user: { email: userInfo.email, name: userInfo.name, picture: userInfo.picture }, kiteAccessToken: null, kiteExpiresAt: null });
            res.writeHead(302, { Location: '/', 'Set-Cookie': [makeSessionCookie(sessionId), 'google_state=; HttpOnly; Path=/; Max-Age=0'] });
            return res.end();
        } catch (error) {
            res.writeHead(302, { Location: `/auth/login?error=${encodeURIComponent(error.message)}` });
            return res.end();
        }
    }

    // ── Logout ──────────────────────────────────────────────────────────────
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
        const sid = getSessionId(req);
        if (sid) sessions.delete(sid);
        res.writeHead(302, { Location: '/auth/login', 'Set-Cookie': makeSessionCookie('', 0) });
        return res.end();
    }

    // ── Auth guard ──────────────────────────────────────────────────────────
    const guard = authGuard(req, url);
    if (guard === 'login') {
        if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Authentication required.' });
        res.writeHead(302, { Location: '/auth/login' });
        return res.end();
    }

    // ── User info API ───────────────────────────────────────────────────────
    if (url.pathname === '/api/me') {
        const s = getSession(req);
        return json(res, 200, { user: s?.user || null, kiteConnected: Boolean(s?.kiteAccessToken && s?.kiteExpiresAt > Date.now()) });
    }

    if (url.pathname === '/api/health') return json(res, 200, { ok: true, kiteConfigured: Boolean(KITE_API_KEY && KITE_API_SECRET) });

    // ── Kite OAuth ──────────────────────────────────────────────────────────
    if (url.pathname === '/api/auth/kite') {
        if (!KITE_API_KEY || !KITE_API_SECRET) return json(res, 500, { error: 'Kite credentials are not configured.' });
        const state = randomBytes(24).toString('hex');
        const login = new URL('https://kite.zerodha.com/connect/login');
        login.searchParams.set('v', '3');
        login.searchParams.set('api_key', KITE_API_KEY);
        login.searchParams.set('redirect_params', `state=${state}`);
        res.writeHead(302, { Location: login.toString(), 'Set-Cookie': makeStateCookie('kite_state', state) });
        return res.end();
    }

    if (url.pathname === '/api/auth/kite/callback') {
        const requestToken = url.searchParams.get('request_token'), state = url.searchParams.get('state');
        if (!requestToken || !state || !verifyStateCookie(req, 'kite_state', state)) { res.writeHead(400); return res.end('Invalid or expired Kite sign-in request. Please try connecting again.'); }
        const checksum = createHash('sha256').update(`${KITE_API_KEY}${requestToken}${KITE_API_SECRET}`).digest('hex');
        try {
            const response = await fetch('https://api.kite.trade/session/token', { method: 'POST', headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: KITE_API_KEY, request_token: requestToken, checksum }) });
            const body = await response.json();
            if (!response.ok || body.status !== 'success') throw new Error(body.message || 'Kite authentication failed');
            const sid = getSessionId(req);
            const session = sid ? sessions.get(sid) : null;
            if (session) {
                session.kiteAccessToken = body.data.access_token;
                session.kiteExpiresAt = Date.now() + 72000000;
            }
            res.writeHead(302, { Location: '/', 'Set-Cookie': 'kite_state=; HttpOnly; Path=/; Max-Age=0' });
            return res.end();
        } catch (error) { res.writeHead(502); return res.end(`Kite connection failed: ${error.message}`); }
    }

    if (url.pathname === '/api/dashboard') {
        const session = getSession(req);
        if (!session?.kiteAccessToken || session.kiteExpiresAt < Date.now()) return json(res, 401, { connected: false, error: 'Connect your Zerodha account to load live holdings.' });
        try {
            const [holdings, positions, margins, orders, profile] = await Promise.all([
                kite('/portfolio/holdings', session.kiteAccessToken),
                kite('/portfolio/positions', session.kiteAccessToken),
                kite('/user/margins', session.kiteAccessToken),
                kite('/orders', session.kiteAccessToken),
                kite('/user/profile', session.kiteAccessToken),
            ]);
            return json(res, 200, getDashboard(holdings, positions, margins, orders, profile));
        } catch (error) { return json(res, 502, { connected: false, error: error.message }); }
    }

    // ── Tradebook endpoints ────────────────────────────────────────────────────
    if (url.pathname === '/api/tradebook' && req.method === 'GET') {
        if (!tradebookCache) return json(res, 200, { loaded: false, trades: [], realizedPnl: 0, message: 'No tradebook uploaded yet.' });
        return json(res, 200, { loaded: true, ...tradebookCache });
    }

    if (url.pathname === '/api/tradebook/analytics' && req.method === 'GET') {
        if (!tradebookCache || !tradebookCache.trades || !tradebookCache.trades.length) {
            return json(res, 200, { available: false });
        }
        const analytics = computeAdvancedAnalytics(tradebookCache.trades);
        return json(res, 200, { available: true, ...analytics });
    }

    if (url.pathname === '/api/trades/sync' && req.method === 'POST') {
        const session = getSession(req);
        if (!session?.kiteAccessToken || session.kiteExpiresAt < Date.now()) return json(res, 401, { error: 'Not authenticated. Connect Zerodha first.' });
        try {
            const kiteTrades = await kite('/trades', session.kiteAccessToken);
            const newRaw = (kiteTrades || [])
                .filter(t => (t.transaction_type === 'BUY' || t.transaction_type === 'SELL'))
                .map(kiteTradeToRaw);
            const history = loadTradesHistory();
            const existingIds = new Set(history.trades.map(t => t.tradeId));
            const brandNew = newRaw.filter(t => t.tradeId && !existingIds.has(t.tradeId));
            history.trades.push(...brandNew);
            history.trades.sort((a, b) => new Date(a.time) - new Date(b.time));
            history.lastSyncAt = new Date().toISOString();
            history.syncCount++;
            saveTradesHistory(history);
            const valid = history.trades.filter(t => t.symbol && (t.type === 'buy' || t.type === 'sell') && t.qty > 0 && t.price > 0);
            if (valid.length > 0) {
                const { completedTrades, realizedPnl } = computeFifoPnl(valid);
                tradebookCache = { trades: completedTrades, realizedPnl, uploadedAt: history.lastSyncAt, filename: 'kite-api-sync', rawCount: valid.length, source: 'kite-sync' };
                console.log(`[Kite Sync] ${brandNew.length} new trades · Total: ${valid.length} raw → ${completedTrades.length} completed · P&L ₹${realizedPnl}`);
            }
            return json(res, 200, { ok: true, newTrades: brandNew.length, totalRaw: history.trades.length, completed: tradebookCache?.trades?.length || 0, realizedPnl: tradebookCache?.realizedPnl || 0, lastSyncAt: history.lastSyncAt });
        } catch (error) { return json(res, 502, { error: `Sync failed: ${error.message}` }); }
    }

    if (url.pathname === '/api/tradebook/upload' && req.method === 'POST') {
        const ct = req.headers['content-type'] || '';
        const boundaryMatch = ct.match(/boundary=(.+)$/);
        if (!boundaryMatch) return json(res, 400, { error: 'Expected multipart/form-data' });
        const body = await readBody(req);
        const fileInfo = extractFileFromMultipart(body, boundaryMatch[1]);
        if (!fileInfo) return json(res, 400, { error: 'No file found in upload.' });

        const { filename, data } = fileInfo;
        const isXlsx = filename.endsWith('.xlsx') || filename.endsWith('.xls');

        try {
            if (isXlsx) {
                const wb = XLSX.read(data, { type: 'buffer', dense: false });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

                // Auto-detect if this is a Zerodha P&L report
                const isPnlReport = rows.some(r => r.some(c => String(c).includes('P&L Statement') || String(c).includes('Realized P&L')));

                if (isPnlReport) {
                    // Parse as P&L Report
                    const savedFilename = `pnl-uploaded-${Date.now()}.xlsx`;
                    const filePath = join(root, savedFilename);
                    writeFileSync(filePath, data);

                    const result = await parsePnlXlsx(filePath);
                    tradebookCache = {
                        trades: result.completedTrades,
                        realizedPnl: result.realizedPnl,
                        charges: result.charges,
                        unrealizedPnl: result.unrealizedPnl,
                        uploadedAt: new Date().toISOString(),
                        filename: savedFilename,
                        rawCount: result.symbolRows.length,
                        source: 'pnl-report',
                    };
                    console.log(`[P&L Report] Uploaded "${filename}": ${result.symbolRows.length} symbols · Realized P&L ₹${result.realizedPnl}`);
                    return json(res, 200, { ok: true, source: 'pnl-report', trades: result.completedTrades.length, realizedPnl: result.realizedPnl, rawCount: result.symbolRows.length });
                } else {
                    // Parse as Tradebook XLSX
                    const rawTrades = parseTradebookXlsxRows(rows);
                    if (rawTrades.length === 0) return json(res, 400, { error: 'XLSX parsed 0 valid trades. Check sheet format.' });

                    const savedFilename = `tradebook-uploaded-${Date.now()}.xlsx`;
                    const filePath = join(root, savedFilename);
                    writeFileSync(filePath, data);

                    const { completedTrades, realizedPnl } = computeFifoPnl(rawTrades);
                    tradebookCache = {
                        trades: completedTrades,
                        realizedPnl,
                        uploadedAt: new Date().toISOString(),
                        filename: savedFilename,
                        rawCount: rawTrades.length,
                        source: 'tradebook-xlsx',
                    };
                    console.log(`[Tradebook XLSX] Uploaded "${filename}": ${rawTrades.length} rows → ${completedTrades.length} trades · P&L ₹${realizedPnl}`);
                    return json(res, 200, { ok: true, source: 'tradebook-xlsx', trades: completedTrades.length, realizedPnl, rawCount: rawTrades.length });
                }
            } else {
                // Assume CSV
                const csvText = data.toString('utf8');
                const rawTrades = parseTradebookCsv(csvText);
                if (rawTrades.length === 0) return json(res, 400, { error: 'CSV parsed 0 valid trades. Check file format.' });

                const savedFilename = `tradebook-uploaded-${Date.now()}.csv`;
                writeFileSync(join(root, savedFilename), csvText, 'utf8');

                const { completedTrades, realizedPnl } = computeFifoPnl(rawTrades);
                tradebookCache = {
                    trades: completedTrades,
                    realizedPnl,
                    uploadedAt: new Date().toISOString(),
                    filename: savedFilename,
                    rawCount: rawTrades.length,
                    source: 'tradebook-csv',
                };
                console.log(`[Tradebook CSV] Uploaded "${filename}": ${rawTrades.length} rows → ${completedTrades.length} trades · P&L ₹${realizedPnl}`);
                return json(res, 200, { ok: true, source: 'tradebook-csv', trades: completedTrades.length, realizedPnl, rawCount: rawTrades.length });
            }
        } catch (e) {
            return json(res, 500, { error: `Parse error: ${e.message}` });
        }
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        const session = getSession(req);
        if (session) { session.kiteAccessToken = null; session.kiteExpiresAt = null; }
        return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    const file = join(root, normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404, secHeaders); return res.end('Not found'); }
    const ct = mime[extname(file)] || 'application/octet-stream';
    const csp = ct.includes('html') ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'" } : {};
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store', ...secHeaders, ...csp });
    createReadStream(file).pipe(res);
}

createServer((req, res) => handler(req, res).catch(error => json(res, 500, { error: error.message }))).listen(Number(PORT), () => console.log(`FinDash running on http://localhost:${PORT}`));
