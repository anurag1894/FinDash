import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
if (existsSync(join(root, '.env.local'))) for (const line of readFileSync(join(root, '.env.local'), 'utf8').split(/\r?\n/)) { const match = line.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/); if (match && !process.env[match[1]]) process.env[match[1]] = match[2]; }
const { KITE_API_KEY, KITE_API_SECRET, PORT = '4173' } = process.env;
const sessions = new Map(), states = new Map();
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const readCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
const kite = async (path, token, options = {}) => { const response = await fetch(`https://api.kite.trade${path}`, { ...options, headers: { 'X-Kite-Version': '3', Authorization: `token ${KITE_API_KEY}:${token}`, ...options.headers } }); const body = await response.json().catch(() => ({})); if (!response.ok || body.status === 'error') throw new Error(body.message || 'Kite Connect request failed'); return body.data; };
const amount = value => Math.round((value || 0) * 100) / 100;

// ── Tradebook: CSV parser + FIFO P&L engine ──────────────────────────────────
let tradebookCache = null; // { trades, realizedPnl, uploadedAt, filename, source }

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
    const inventory = {}; // symbol -> [{qty, price, date}]
    let realizedPnl = 0;
    const completedTrades = [];
    let tradeNo = 0;

    for (const t of rawTrades) {
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
                    entryPrice: amount(entryPrice),
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

    if (url.pathname === '/api/health') return json(res, 200, { ok: true, kiteConfigured: Boolean(KITE_API_KEY && KITE_API_SECRET) });

    if (url.pathname === '/api/auth/kite') {
        if (!KITE_API_KEY || !KITE_API_SECRET) return json(res, 500, { error: 'Kite credentials are not configured.' });
        const state = randomBytes(24).toString('hex');
        states.set(state, Date.now());
        const login = new URL('https://kite.zerodha.com/connect/login');
        login.searchParams.set('v', '3');
        login.searchParams.set('api_key', KITE_API_KEY);
        login.searchParams.set('redirect_params', `state=${state}`);
        res.writeHead(302, { Location: login.toString(), 'Set-Cookie': `kite_state=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/kite; Max-Age=600` });
        return res.end();
    }

    if (url.pathname === '/api/auth/kite/callback') {
        const requestToken = url.searchParams.get('request_token'), state = url.searchParams.get('state'), expected = readCookies(req).kite_state;
        if (!requestToken || !state || state !== expected || !states.has(state)) { res.writeHead(400); return res.end('Invalid or expired Kite sign-in request.'); }
        states.delete(state);
        const checksum = createHash('sha256').update(`${KITE_API_KEY}${requestToken}${KITE_API_SECRET}`).digest('hex');
        try {
            const response = await fetch('https://api.kite.trade/session/token', { method: 'POST', headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: KITE_API_KEY, request_token: requestToken, checksum }) });
            const body = await response.json();
            if (!response.ok || body.status !== 'success') throw new Error(body.message || 'Kite authentication failed');
            const id = randomBytes(32).toString('base64url');
            sessions.set(id, { accessToken: body.data.access_token, expiresAt: Date.now() + 72000000 });
            res.writeHead(302, { Location: '/', 'Set-Cookie': `findash_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=72000` });
            return res.end();
        } catch (error) { res.writeHead(502); return res.end(`Kite connection failed: ${error.message}`); }
    }

    if (url.pathname === '/api/dashboard') {
        const session = sessions.get(readCookies(req).findash_session);
        if (!session || session.expiresAt < Date.now()) return json(res, 401, { connected: false, error: 'Connect your Zerodha account to load live holdings.' });
        try {
            const [holdings, positions, margins, orders, profile] = await Promise.all([
                kite('/portfolio/holdings', session.accessToken),
                kite('/portfolio/positions', session.accessToken),
                kite('/user/margins', session.accessToken),
                kite('/orders', session.accessToken),
                kite('/user/profile', session.accessToken),
            ]);
            return json(res, 200, getDashboard(holdings, positions, margins, orders, profile));
        } catch (error) { return json(res, 502, { connected: false, error: error.message }); }
    }

    // ── Tradebook endpoints ────────────────────────────────────────────────────
    if (url.pathname === '/api/tradebook' && req.method === 'GET') {
        if (!tradebookCache) return json(res, 200, { loaded: false, trades: [], realizedPnl: 0, message: 'No tradebook uploaded yet.' });
        return json(res, 200, { loaded: true, ...tradebookCache });
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
        sessions.delete(readCookies(req).findash_session);
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'findash_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    const file = join(root, normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
}

createServer((req, res) => handler(req, res).catch(error => json(res, 500, { error: error.message }))).listen(Number(PORT), () => console.log(`FinDash running on http://localhost:${PORT}`));
