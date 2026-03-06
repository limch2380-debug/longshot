/**
 * LONGSHOT — Antigravity Trading Quest
 * 바이낸스 선물 100배 레버리지 기반 게임
 * 실시간 BTC + 롱/숏 전략 사전선택 + 게임 비주얼 + 바이낸스 실전 주문
 */

const GS = {
    mode: null, playMode: 'practice', totalStages: 0, currentStage: 0, rtRound: 0, rtDirection: null, rtMode: false,
    seed: 10000, balance: 10000, isRunning: false,
    btcPrice: 0, prevPrice: 0, open24h: 0, change24h: 0,
    plan: [],        // ['LONG','SHORT','LONG'] — 사전 선택된 방향 배열
    direction: null, entryPrice: 0, tpPrice: 0, slPrice: 0,
    wsConnected: false,
    binanceOrderId: null,
    currentSymbol: 'BTCUSDT',
    currentCoinName: 'BTC/USDT',
    maxLeverage: 100,
    coinSelectedAt: 0,
};

const CFG_RT = { stages: 1 };
const CFG = {
    EASY: { stages: 3, mult: 8, grav: 1.0 },
    NORMAL: { stages: 5, mult: 32, grav: 2.0 },
    LEGEND: { stages: 10, mult: 1024, grav: 4.0 },
    TP: 100, SL: 100, LEV: 100,
};

const $ = id => document.getElementById(id);
const screens = { select: $('screenSelect'), plan: $('screenPlan'), game: $('screenGame'), over: $('screenOver'), win: $('screenWin'), realtime: $('screenRealtime') };

// ============================================================
// BINANCE WEBSOCKET
// ============================================================
class PriceFeed {
    constructor() { this.ws = null; this.listeners = []; this.retries = 0; }
    connect(symbol) {
        if (symbol) GS.currentSymbol = symbol;
        const sym = GS.currentSymbol.toLowerCase();
        if (this.ws) { try { this.ws.close(); } catch (e) { } }
        try {
            this.ws = new WebSocket('wss://fstream.binance.com/ws/' + sym + '@ticker');
            this.ws.onopen = () => { console.log('✅ WS connected'); GS.wsConnected = true; this.retries = 0; };
            this.ws.onmessage = e => {
                const d = JSON.parse(e.data);
                GS.prevPrice = GS.btcPrice;
                GS.btcPrice = parseFloat(d.c);
                GS.open24h = parseFloat(d.o);
                GS.change24h = parseFloat(d.P);
                this.notify({ price: GS.btcPrice, prev: GS.prevPrice, change: GS.change24h });
            };
            this.ws.onclose = () => { GS.wsConnected = false; if (this.retries < 8) { this.retries++; setTimeout(() => this.connect(), Math.min(1000 * this.retries, 8000)); } };
            this.ws.onerror = () => { GS.wsConnected = false; };
        } catch (e) { this.fallbackREST(); }
    }
    async fallbackREST() {
        try {
            const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=' + GS.currentSymbol);
            const d = await r.json();
            GS.btcPrice = parseFloat(d.lastPrice); GS.open24h = parseFloat(d.openPrice); GS.change24h = parseFloat(d.priceChangePercent);
            this.notify({ price: GS.btcPrice, prev: GS.btcPrice, change: GS.change24h });
            this._poll = setInterval(async () => { try { const r2 = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + GS.currentSymbol); const d2 = await r2.json(); GS.prevPrice = GS.btcPrice; GS.btcPrice = parseFloat(d2.price); GS.change24h = ((GS.btcPrice - GS.open24h) / GS.open24h * 100); this.notify({ price: GS.btcPrice, prev: GS.prevPrice, change: GS.change24h }) } catch (e) { } }, 2000);
        } catch (e) { }
    }
    on(cb) { this.listeners.push(cb); }
    notify(d) { this.listeners.forEach(cb => cb(d)); }
}

// ============================================================
// BINANCE FUTURES API (실전 모드)
// ============================================================
class BinanceFutures {
    constructor() { this.key = ''; this.secret = ''; }
    setCredentials(key, secret) { this.key = key; this.secret = secret; }

    async _sign(params) {
        const qs = new URLSearchParams(params).toString();
        const enc = new TextEncoder();
        const keyData = await crypto.subtle.importKey('raw', enc.encode(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sig = await crypto.subtle.sign('HMAC', keyData, enc.encode(qs));
        const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
        return qs + '&signature=' + hex;
    }

    async _req(method, endpoint, params = {}) {
        params.timestamp = Date.now();
        params.recvWindow = 5000;
        const signed = await this._sign(params);
        const base = 'https://fapi.binance.com';
        const url = method === 'GET' ? `${base}${endpoint}?${signed}` : `${base}${endpoint}`;
        const opts = { method, headers: { 'X-MBX-APIKEY': this.key, 'Content-Type': 'application/x-www-form-urlencoded' } };
        if (method !== 'GET') opts.body = signed;
        const res = await fetch(url, opts);
        return res.json();
    }

    // 시장가 주문 + TP/SL 예약
    async openPosition(direction, quantity, entryPrice) {
        const side = direction === 'LONG' ? 'BUY' : 'SELL';
        const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';

        // 100배 레버리지 설정 (Config)
        await this._req('POST', '/fapi/v1/leverage', { symbol: GS.currentSymbol, leverage: GS.maxLeverage });

        // 시장가 진입
        const order = await this._req('POST', '/fapi/v1/order', {
            symbol: GS.currentSymbol, side, type: 'MARKET', quantity: quantity.toFixed(3),
        });

        if (order.orderId) {
            GS.binanceOrderId = order.orderId;

            // TP 주문
            const tpPrice = direction === 'LONG'
                ? (entryPrice * (1 + CFG.TP / 100)).toFixed(2)
                : (entryPrice * (1 - CFG.TP / 100)).toFixed(2);

            await this._req('POST', '/fapi/v1/order', {
                symbol: GS.currentSymbol, side: closeSide, type: 'TAKE_PROFIT_MARKET',
                stopPrice: tpPrice, closePosition: 'true', workingType: 'MARK_PRICE',
            });

            // SL 주문
            const slPrice = direction === 'LONG'
                ? (entryPrice * (1 - CFG.SL / 100)).toFixed(2)
                : (entryPrice * (1 + CFG.SL / 100)).toFixed(2);

            await this._req('POST', '/fapi/v1/order', {
                symbol: GS.currentSymbol, side: closeSide, type: 'STOP_MARKET',
                stopPrice: slPrice, closePosition: 'true', workingType: 'MARK_PRICE',
            });

            return { success: true, orderId: order.orderId };
        }
        return { success: false, error: order };
    }

    // 모든 미체결 주문 취소
    async cancelAllOrders() {
        return this._req('DELETE', '/fapi/v1/allOpenOrders', { symbol: GS.currentSymbol });
    }

    // 포지션 조회
    async getPosition() {
        const positions = await this._req('GET', '/fapi/v2/positionRisk', { symbol: GS.currentSymbol });
        if (Array.isArray(positions)) {
            return positions.find(p => p.symbol === GS.currentSymbol && parseFloat(p.positionAmt) !== 0);
        }
        return null;
    }
}

// ============================================================
// BG PARTICLE CANVAS
// ============================================================
class BGCanvas {
    constructor(canvas) {
        this.c = canvas; this.ctx = canvas.getContext('2d'); this.ps = [];
        this.resize(); window.addEventListener('resize', () => this.resize()); this.init();
    }
    resize() { this.c.width = innerWidth; this.c.height = innerHeight; }
    init() {
        const n = Math.floor((this.c.width * this.c.height) / 12000);
        this.ps = [];
        for (let i = 0; i < n; i++) this.ps.push({
            x: Math.random() * this.c.width, y: Math.random() * this.c.height,
            vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3,
            r: Math.random() * 1.5 + .5, a: Math.random() * .35 + .08,
            cl: ['#00f0ff', '#7b2ff7', '#ff006e', '#ffd700'][Math.floor(Math.random() * 4)]
        });
    }
    draw(grav = 0) {
        const { ctx: c, ps } = this; c.clearRect(0, 0, this.c.width, this.c.height);
        ps.forEach(p => {
            p.x += p.vx; p.y += p.vy + grav * .015;
            if (p.x < 0) p.x = this.c.width; if (p.x > this.c.width) p.x = 0; if (p.y < 0) p.y = this.c.height; if (p.y > this.c.height) p.y = 0;
            c.beginPath(); c.arc(p.x, p.y, p.r, 0, Math.PI * 2); c.fillStyle = p.cl; c.globalAlpha = p.a; c.fill();
        }); c.globalAlpha = 1;
    }
}

// ============================================================
// GAME VISUAL CANVAS (수익/손실 애니메이션)
// ============================================================
class GameVisualCanvas {
    constructor(canvas) {
        this.c = canvas; this.ctx = canvas.getContext('2d');
        this.particles = []; this.state = 'neutral'; // 'profit' | 'loss' | 'neutral'
        this.intensity = 0;
        this.resize(); window.addEventListener('resize', () => this.resize());
    }
    resize() {
        const p = this.c.parentElement;
        if (p) { this.c.width = p.clientWidth; this.c.height = p.clientHeight; }
    }
    setState(state, intensity) {
        this.state = state;
        this.intensity = Math.min(intensity, 1);
    }
    spawnBurst(isProfit) {
        const cx = this.c.width / 2, cy = this.c.height / 2;
        const colors = isProfit ? ['#00ff88', '#00f0ff', '#7bff7b', '#ffd700'] : ['#ff3b5c', '#ff006e', '#ff6347', '#cc0033'];
        for (let i = 0; i < 20; i++) {
            const a = Math.random() * Math.PI * 2, sp = Math.random() * 4 + 1;
            this.particles.push({
                x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (isProfit ? 2 : 0),
                r: Math.random() * 4 + 1, alpha: 1, color: colors[Math.floor(Math.random() * colors.length)],
                life: 60 + Math.random() * 40, age: 0, drag: .98, grav: isProfit ? -.03 : .05
            });
        }
    }
    draw() {
        const { ctx: c, particles: ps } = this;
        c.clearRect(0, 0, this.c.width, this.c.height);
        const cx = this.c.width / 2, cy = this.c.height / 2;

        // Ambient glow
        if (this.state !== 'neutral') {
            const grad = c.createRadialGradient(cx, cy, 0, cx, cy, Math.max(this.c.width, this.c.height) * .5);
            if (this.state === 'profit') {
                grad.addColorStop(0, `rgba(0,255,136,${.06 * this.intensity})`);
                grad.addColorStop(1, 'transparent');
            } else {
                grad.addColorStop(0, `rgba(255,59,92,${.08 * this.intensity})`);
                grad.addColorStop(1, 'transparent');
            }
            c.fillStyle = grad; c.fillRect(0, 0, this.c.width, this.c.height);
        }

        // Rising/falling streaks
        if (this.intensity > .2) {
            const count = Math.floor(this.intensity * 8);
            for (let i = 0; i < count; i++) {
                const x = cx + (Math.random() - .5) * this.c.width * .6;
                const len = 20 + Math.random() * 40 * this.intensity;
                c.beginPath();
                if (this.state === 'profit') {
                    const y = Math.random() * this.c.height;
                    c.moveTo(x, y); c.lineTo(x, y - len);
                    c.strokeStyle = `rgba(0,255,136,${.1 + Math.random() * .15})`;
                } else {
                    const y = Math.random() * this.c.height;
                    c.moveTo(x, y); c.lineTo(x, y + len);
                    c.strokeStyle = `rgba(255,59,92,${.1 + Math.random() * .15})`;
                }
                c.lineWidth = 1 + Math.random() * 2; c.stroke();
            }
        }

        // Particles
        for (let i = ps.length - 1; i >= 0; i--) {
            const p = ps[i];
            p.age++; p.x += p.vx; p.y += p.vy; p.vx *= p.drag; p.vy *= p.drag; p.vy += p.grav;
            p.alpha = Math.max(0, 1 - p.age / p.life);
            if (p.alpha <= 0) { ps.splice(i, 1); continue; }
            c.beginPath(); c.arc(p.x, p.y, p.r * p.alpha, 0, Math.PI * 2);
            c.fillStyle = p.color; c.globalAlpha = p.alpha * .7; c.fill();
        }
        c.globalAlpha = 1;
    }
}

// ============================================================
// CONFETTI
// ============================================================
class Confetti {
    constructor(canvas) {
        this.c = canvas; this.ctx = canvas.getContext('2d'); this.ps = []; this.running = false;
        this.resize(); window.addEventListener('resize', () => this.resize());
    }
    resize() { this.c.width = innerWidth; this.c.height = innerHeight }
    start(n = 200) {
        this.ps = []; const cls = ['#FFD700', '#FF6347', '#00FF88', '#00F0FF', '#FF006E', '#7B2FF7'];
        for (let i = 0; i < n; i++)this.ps.push({ x: this.c.width / 2 + (Math.random() - .5) * 200, y: this.c.height / 2, vx: (Math.random() - .5) * 14, vy: (Math.random() - 1) * 14 - 4, sz: Math.random() * 7 + 3, rot: Math.random() * 6.28, rs: (Math.random() - .5) * .2, cl: cls[Math.floor(Math.random() * cls.length)], a: 1, g: .14 + Math.random() * .1 });
        this.running = true;
    }
    draw() {
        if (!this.running) return; const { ctx: c } = this; c.clearRect(0, 0, this.c.width, this.c.height);
        let alive = false; this.ps.forEach(p => {
            if (p.a <= 0) return; alive = true; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= .98; p.rot += p.rs; if (p.y > this.c.height) p.a -= .02;
            c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.globalAlpha = Math.max(0, p.a); c.fillStyle = p.cl; c.fillRect(-p.sz / 2, -p.sz / 4, p.sz, p.sz / 2); c.restore();
        });
        if (!alive) this.running = false;
    }
    stop() { this.running = false; this.ctx.clearRect(0, 0, this.c.width, this.c.height); }
}

// ============================================================
// SOUND
// ============================================================
class SFX {
    constructor() { this.ctx = null; this.ok = false }
    init() { if (this.ok) return; try { this.ctx = new (AudioContext || webkitAudioContext)(); this.ok = true; } catch (e) { } }
    play(t) {
        if (!this.ok) this.init(); if (!this.ctx) return;
        const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.connect(g); g.connect(this.ctx.destination); const n = this.ctx.currentTime;
        if (t === 'click') { o.type = 'sine'; o.frequency.setValueAtTime(800, n); o.frequency.exponentialRampToValueAtTime(1200, n + .08); g.gain.setValueAtTime(.08, n); g.gain.exponentialRampToValueAtTime(.001, n + .15); o.start(n); o.stop(n + .15); }
        else if (t === 'start') { o.type = 'sine'; o.frequency.setValueAtTime(400, n); o.frequency.exponentialRampToValueAtTime(1600, n + .25); g.gain.setValueAtTime(.1, n); g.gain.exponentialRampToValueAtTime(.001, n + .35); o.start(n); o.stop(n + .35); }
        else if (t === 'win') { [523, 659, 784, 1047].forEach((f, i) => { const oo = this.ctx.createOscillator(), gg = this.ctx.createGain(); oo.connect(gg); gg.connect(this.ctx.destination); oo.type = 'sine'; oo.frequency.setValueAtTime(f, n + i * .1); gg.gain.setValueAtTime(.08, n + i * .1); gg.gain.exponentialRampToValueAtTime(.001, n + i * .1 + .25); oo.start(n + i * .1); oo.stop(n + i * .1 + .25); }); }
        else if (t === 'lose') { o.type = 'sawtooth'; o.frequency.setValueAtTime(400, n); o.frequency.exponentialRampToValueAtTime(80, n + .5); g.gain.setValueAtTime(.06, n); g.gain.exponentialRampToValueAtTime(.001, n + .7); o.start(n); o.stop(n + .7); }
    }
}

// ============================================================
// LEGEND FX
// ============================================================
class LegendFX {
    constructor(canvas) { this.c = canvas; this.ctx = canvas.getContext('2d'); this.ps = []; this.running = false; this.resize(); window.addEventListener('resize', () => this.resize()); }
    resize() { this.c.width = innerWidth; this.c.height = innerHeight; }
    start() { this.ps = []; const cls = ['#FFD700', '#FFA500', '#FF006E', '#00F0FF']; for (let i = 0; i < 200; i++) { const a = Math.random() * Math.PI * 2, sp = Math.random() * 3 + .5; this.ps.push({ x: this.c.width / 2, y: this.c.height / 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, sz: Math.random() * 3 + 1, cl: cls[Math.floor(Math.random() * cls.length)], trail: [] }); } this.running = true; }
    draw() { if (!this.running) return; const { ctx: c } = this; c.fillStyle = 'rgba(0,0,0,.04)'; c.fillRect(0, 0, this.c.width, this.c.height); this.ps.forEach(p => { p.trail.push({ x: p.x, y: p.y }); if (p.trail.length > 15) p.trail.shift(); p.x += p.vx; p.y += p.vy; p.vx += (Math.random() - .5) * .08; p.vy += (Math.random() - .5) * .08; p.trail.forEach((t, i) => { c.beginPath(); c.arc(t.x, t.y, p.sz * (i / p.trail.length), 0, Math.PI * 2); c.fillStyle = p.cl; c.globalAlpha = (i / p.trail.length) * .25; c.fill(); }); c.beginPath(); c.arc(p.x, p.y, p.sz, 0, Math.PI * 2); c.fillStyle = p.cl; c.globalAlpha = .7; c.fill(); }); c.globalAlpha = 1; }
    stop() { this.running = false; this.ctx.clearRect(0, 0, this.c.width, this.c.height); }
}

// ============================================================
// TOP MOVER — 24시간 등락률 상위 1위 코인 자동 선정
// ============================================================
class TopMover {
    constructor() {
        this.coinData = null;
        this.selectTime = 0;
        this.checkInterval = null;
    }
    async findTopMover() {
        try {
            // Get active TRADING symbols first
            const infoRes = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
            const info = await infoRes.json();
            const activeSymbols = new Set(
                info.symbols.filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL').map(s => s.symbol)
            );

            // Get 24h ticker
            const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
            const tickers = await res.json();

            // Filter only active USDT pairs with volume
            const usdt = tickers
                .filter(t => t.symbol.endsWith('USDT') && activeSymbols.has(t.symbol) && parseFloat(t.quoteVolume) > 10000000)
                .sort((a, b) => Math.abs(parseFloat(b.priceChangePercent)) - Math.abs(parseFloat(a.priceChangePercent)));
            if (usdt.length > 0) {
                this.coinData = usdt[0];
                return this.coinData;
            }
        } catch (e) { console.warn('TopMover fetch failed:', e); }
        return null;
    }
    async getMaxLeverage(symbol) {
        try {
            const res = await fetch('https://fapi.binance.com/fapi/v1/leverageBracket');
            const brackets = await res.json();
            const found = brackets.find(b => b.symbol === symbol);
            if (found && found.brackets && found.brackets.length > 0) {
                return found.brackets[0].initialLeverage;
            }
        } catch (e) { console.warn('Leverage fetch failed:', e); }
        return 20; // default fallback
    }
    async selectCoin() {
        const coin = await this.findTopMover();
        if (!coin) return;
        GS.currentSymbol = coin.symbol;
        const base = coin.symbol.replace('USDT', '');
        GS.currentCoinName = base + '/USDT';
        GS.coinSelectedAt = Date.now();
        const maxLev = await this.getMaxLeverage(coin.symbol);
        GS.maxLeverage = maxLev;
        CFG.LEV = maxLev;
        // Update TP/SL: 익절 100%, 손절 100% (레버리지 기준)
        CFG.TP = (100 / maxLev);
        CFG.SL = (100 / maxLev);
        this.updateUI(coin, maxLev);
        // Baccarat threshold will be synced in Game.onPrice or Game.selectCoin call
        // Save selection (v2 to avoid cached bad coins)
        try { localStorage.setItem('longshot_topmover_v2', JSON.stringify({ symbol: coin.symbol, coinName: GS.currentCoinName, maxLev, selectedAt: GS.coinSelectedAt, change: coin.priceChangePercent })); } catch (e) { }
        return coin;
    }
    loadSaved() {
        try {
            const saved = localStorage.getItem('longshot_topmover_v2');
            if (saved) {
                const d = JSON.parse(saved);
                const elapsed = Date.now() - d.selectedAt;
                if (elapsed < 24 * 60 * 60 * 1000) { // still within 24h
                    GS.currentSymbol = d.symbol;
                    GS.currentCoinName = d.coinName;
                    GS.maxLeverage = d.maxLev;
                    GS.coinSelectedAt = d.selectedAt;
                    CFG.LEV = d.maxLev;
                    CFG.TP = (100 / d.maxLev);
                    CFG.SL = (100 / d.maxLev);
                    if (window.game && window.game.bigRoad) window.game.bigRoad.setThreshold(100 / d.maxLev);
                    return true;
                }
            }
        } catch (e) { }
        return false;
    }
    updateUI(coin, maxLev) {
        const base = GS.currentCoinName;
        const chg = parseFloat(coin.priceChangePercent).toFixed(2);
        // Update all symbol labels
        const ts = $('tickerSymbol'); if (ts) ts.innerHTML = base + ' <span class="top-mover-badge">🔥 24H TOP <span class="top-mover-change">' + (chg > 0 ? '+' : '') + chg + '%</span></span>';
        const hs = $('hudSymbol'); if (hs) hs.textContent = base;
        const hl = $('hudLev'); if (hl) hl.textContent = 'x' + maxLev;
        const rs = $('rtSymbol'); if (rs) rs.textContent = base;
        const cv = $('btnChartView'); if (cv) cv.href = 'https://www.tradingview.com/chart/?symbol=BINANCE%3A' + GS.currentSymbol + 'PERP';
        const rd = $('rtCardDesc'); if (rd) rd.textContent = '지금 바로 ' + base + ' 방향을 예측하세요';
        // Update TP/SL labels
        const tpPct = (100 / maxLev).toFixed(1);
        const tpL = $('tpLabel'); if (tpL) tpL.textContent = 'TP +' + tpPct + '%';
        const slL = $('slLabel'); if (slL) slL.textContent = 'SL -' + tpPct + '%';
    }
    startAutoRefresh() {
        this.checkInterval = setInterval(async () => {
            const elapsed = Date.now() - GS.coinSelectedAt;
            if (elapsed >= 24 * 60 * 60 * 1000 && !GS.isRunning) {
                console.log('⏰ 24시간 경과 — 코인 재선정');
                await this.selectCoin();
                if (window.game && window.game.feed) {
                    window.game.feed.connect(GS.currentSymbol);
                }
            }
        }, 60000); // check every minute
    }
}

// ============================================================
// BACCARAT BIG ROAD (1% 기준 변동 추적)
// ============================================================
class BigRoad {
    constructor() {
        this.refPrice = 0;
        this.threshold = 1.0;
        this.history = [];
        this.maxRows = 6;
        this.miniRows = 4;
        this.maxCols = 40;
        this.gridContainer = $('bacRoad');
        this.isOpen = false;
        this.load();
        this.bindEvents();
        this.fetchHistory();
    }
    setThreshold(val) {
        this.threshold = parseFloat(val);
        console.log('📊 Baccarat Threshold Set:', this.threshold.toFixed(2) + '%');
        if (this.refPrice > 0) this.updateRefUI(this.refPrice);
    }
    bindEvents() {
        const btn = $('btnBacToggle');
        if (btn) btn.addEventListener('click', () => this.toggle());
        const close = $('btnBacClose');
        if (close) close.addEventListener('click', () => this.close());
        const panel = $('bacPanel');
        if (panel) panel.addEventListener('click', (e) => { if (e.target === panel) this.close(); });
    }
    toggle() { this.isOpen ? this.close() : this.open(); }
    open() { this.isOpen = true; $('bacPanel').classList.add('active'); this.render(); }
    close() { this.isOpen = false; $('bacPanel').classList.remove('active'); }
    async fetchHistory() {
        if (this.history.length >= 10) { this.renderAll(); return; }
        try {
            const res = await fetch('https://api.binance.com/api/v3/klines?symbol=' + GS.currentSymbol + '&interval=1h&limit=500');
            const k = await res.json();
            if (!k || !k.length) return;
            let ref = parseFloat(k[0][4]);
            this.history = [];
            for (let i = 1; i < k.length; i++) {
                const cl = parseFloat(k[i][4]);
                const ch = ((cl - ref) / ref) * 100;
                if (ch >= this.threshold) { this.history.push({ dir: 'LONG', price: cl, refPrice: ref, time: k[i][0] }); ref = cl; }
                else if (ch <= -this.threshold) { this.history.push({ dir: 'SHORT', price: cl, refPrice: ref, time: k[i][0] }); ref = cl; }
            }
            this.refPrice = ref;
            this.save();
            this.renderAll();
        } catch (e) { console.warn('BigRoad fetch failed:', e); }
    }
    onPrice(price) {
        if (this.refPrice === 0) { this.refPrice = price; this.updateRefUI(price); return; }
        const chg = ((price - this.refPrice) / this.refPrice) * 100;
        if (chg >= this.threshold) this.addDot('LONG', price);
        else if (chg <= -this.threshold) this.addDot('SHORT', price);
        if (this.isOpen) $('bacPrice').textContent = '$' + price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    addDot(dir, price) {
        this.history.push({ dir, price, refPrice: this.refPrice, time: Date.now() });
        this.refPrice = price;
        this.updateRefUI(price);
        if (this.history.length > this.maxCols * this.maxRows) this.history = this.history.slice(-this.maxCols * this.maxRows);
        this.save();
        this.renderAll();
    }
    updateRefUI(price) {
        const f = '$' + price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const up = price * (1 + this.threshold / 100);
        const dn = price * (1 - this.threshold / 100);
        $('bacRefPrice').textContent = f;
        $('bacNextUp').textContent = '$' + up.toFixed(2);
        $('bacNextDown').textContent = '$' + dn.toFixed(2);
        const mr = $('miniRefPlan'); if (mr) mr.textContent = '기준 ' + f;
    }
    renderAll() {
        if (this.isOpen) this.render();
        this.renderMini('miniRoadPlan', 'miniLongPlan', 'miniShortPlan', 'miniPredictPlan');
        this.renderMini('miniRoadGame', 'miniLongGame', 'miniShortGame', 'miniPredictGame');
        this.renderMini('miniRoadRT', 'miniLongRT', 'miniShortRT', 'miniPredictRT');
        this.updateStats();
        this.updatePrediction();
    }
    _buildColumns() {
        const cols = []; let col = []; let prev = null;
        for (const e of this.history) {
            if (prev === null || e.dir === prev) { col.push(e); if (col.length > this.maxRows) { cols.push(col.slice(0, this.maxRows)); col = col.slice(this.maxRows); } }
            else { if (col.length > 0) cols.push(col); col = [e]; }
            prev = e.dir;
        }
        if (col.length > 0) cols.push(col);
        return cols;
    }
    _renderGrid(container, cols, rows) {
        container.innerHTML = '';
        const tc = Math.max(cols.length, rows === 4 ? 8 : 12);
        for (let c = 0; c < tc; c++) {
            const cd = cols[c] || [];
            for (let r = 0; r < rows; r++) {
                const cell = document.createElement('div');
                if (r < cd.length) { cell.className = 'bac-cell ' + cd[r].dir.toLowerCase(); cell.textContent = cd[r].dir === 'LONG' ? 'L' : 'S'; if (c === cols.length - 1 && r === cd.length - 1) cell.classList.add('latest'); }
                else { cell.className = 'bac-cell empty'; }
                container.appendChild(cell);
            }
        }
        const w = container.parentElement; if (w) w.scrollLeft = w.scrollWidth;
    }
    render() { if (!this.gridContainer) return; this._renderGrid(this.gridContainer, this._buildColumns().slice(-this.maxCols), this.maxRows); }
    renderMini(gid, lid, sid, pid) {
        const ct = $(gid); if (!ct) return;
        this._renderGrid(ct, this._buildColumns().slice(-30), this.miniRows);
        const t = this.history.length, lc = this.history.filter(h => h.dir === 'LONG').length, sc = t - lc;
        const le = $(lid); if (le) le.textContent = 'L:' + lc;
        const se = $(sid); if (se) se.textContent = 'S:' + sc;
        const pe = $(pid);
        if (pe && t > 0) {
            const ld = this.history[t - 1].dir; let st = 1;
            for (let i = t - 2; i >= 0; i--) { if (this.history[i].dir === ld) st++; else break; }
            if (st >= 3) { pe.textContent = ld === 'LONG' ? `🔥 LONG ${st}연속 추세` : `🧊 SHORT ${st}연속 추세`; pe.className = 'mini-road-predict ' + ld.toLowerCase(); }
            else { pe.textContent = `${ld} ×${st} | L:${((lc / t) * 100).toFixed(0)}% S:${((sc / t) * 100).toFixed(0)}%`; pe.className = 'mini-road-predict'; }
        }
    }
    updateStats() {
        const t = this.history.length; if (t === 0) return;
        const lc = this.history.filter(h => h.dir === 'LONG').length, sc = t - lc;
        const lp = ((lc / t) * 100).toFixed(0), sp = ((sc / t) * 100).toFixed(0);
        $('bacLongCount').textContent = lc; $('bacLongPct').textContent = lp + '%';
        $('bacShortCount').textContent = sc; $('bacShortPct').textContent = sp + '%';
        $('bacBarLong').style.width = lp + '%'; $('bacBarShort').style.width = sp + '%';
        let st = 1; const ld = this.history[t - 1].dir;
        for (let i = t - 2; i >= 0; i--) { if (this.history[i].dir === ld) st++; else break; }
        const sv = $('bacStreakVal'); sv.textContent = `${ld} ×${st}`; sv.style.color = ld === 'LONG' ? 'var(--green)' : 'var(--red)';
    }
    updatePrediction() {
        const t = this.history.length;
        if (t < 3) { $('bacPredictIcon').textContent = '⏳'; $('bacPredictTitle').textContent = '데이터 수집 중...'; $('bacPredictTitle').className = 'bac-predict-title neutral'; $('bacPredictDesc').textContent = `${3 - t}개 더 필요합니다`; return; }
        const rc = this.history.slice(-10), lr = rc.filter(h => h.dir === 'LONG').length, sr = rc.length - lr;
        let st = 1; const ld = this.history[t - 1].dir;
        for (let i = t - 2; i >= 0; i--) { if (this.history[i].dir === ld) st++; else break; }
        const pt = $('bacPredictTitle'), pd = $('bacPredictDesc'), pi = $('bacPredictIcon');
        if (st >= 5) { if (ld === 'LONG') { pi.textContent = '🔥'; pt.textContent = '강한 상승 추세!'; pt.className = 'bac-predict-title long'; pd.textContent = `LONG ${st}연속`; } else { pi.textContent = '🧊'; pt.textContent = '강한 하락 추세!'; pt.className = 'bac-predict-title short'; pd.textContent = `SHORT ${st}연속`; } }
        else if (st >= 3) { if (ld === 'LONG') { pi.textContent = '📈'; pt.textContent = '상승 추세 진행 중'; pt.className = 'bac-predict-title long'; pd.textContent = `LONG ${st}연속 · L${lr}:S${sr}`; } else { pi.textContent = '📉'; pt.textContent = '하락 추세 진행 중'; pt.className = 'bac-predict-title short'; pd.textContent = `SHORT ${st}연속 · L${lr}:S${sr}`; } }
        else if (lr >= 7) { pi.textContent = '📈'; pt.textContent = '상승 우세'; pt.className = 'bac-predict-title long'; pd.textContent = `최근 LONG ${lr}개`; }
        else if (sr >= 7) { pi.textContent = '📉'; pt.textContent = '하락 우세'; pt.className = 'bac-predict-title short'; pd.textContent = `최근 SHORT ${sr}개`; }
        else { pi.textContent = '🔄'; pt.textContent = '혼조 · 방향 탐색 중'; pt.className = 'bac-predict-title neutral'; pd.textContent = `L${lr}:S${sr} 패턴 대기`; }
    }
    save() { try { localStorage.setItem('longshot_bigroad', JSON.stringify({ refPrice: this.refPrice, history: this.history.slice(-200) })); } catch (e) { } }
    load() { try { const r = localStorage.getItem('longshot_bigroad'); if (r) { const d = JSON.parse(r); this.refPrice = d.refPrice || 0; this.history = d.history || []; if (this.refPrice > 0) this.updateRefUI(this.refPrice); } } catch (e) { } }
}

// ============================================================
// MAIN GAME
// ============================================================
class Game {
    constructor() {
        this.bg = new BGCanvas($('bgCanvas'));
        this.gameVis = new GameVisualCanvas($('gameCanvas'));
        this.confetti = new Confetti($('confettiCanvas'));
        this.legendFx = new LegendFX($('legendCanvas'));
        this.sfx = new SFX();
        this.feed = new PriceFeed();
        this.futures = new BinanceFutures();
        this.bigRoad = new BigRoad();
        this.topMover = new TopMover();

        this.grav = -0.3;
        this.priceCheckInterval = null;
        this.burstTimer = null;

        // Top Mover coin selection
        const hasSaved = this.topMover.loadSaved();
        if (hasSaved) {
            console.log('📌 저장된 코인 로드:', GS.currentCoinName, 'x' + GS.maxLeverage);
            this.topMover.updateUI({ priceChangePercent: '0', symbol: GS.currentSymbol }, GS.maxLeverage);
            this.feed.connect(GS.currentSymbol);
        } else {
            this.topMover.selectCoin().then(coin => {
                if (coin) {
                    console.log('🔥 24H Top Mover:', GS.currentCoinName, '+' + coin.priceChangePercent + '%', 'x' + GS.maxLeverage);
                    this.feed.connect(GS.currentSymbol);
                } else {
                    console.log('⚠️ TopMover fetch failed, fallback to BTC/USDT');
                    GS.currentSymbol = 'BTCUSDT';
                    GS.currentCoinName = 'BTC/USDT';
                    GS.maxLeverage = 100;
                    CFG.LEV = 100;
                    CFG.TP = 1; CFG.SL = 1;
                    this.topMover.updateUI({ priceChangePercent: '0', symbol: 'BTCUSDT' }, 100);
                    this.feed.connect('BTCUSDT'); // fallback
                }
            });
        }
        this.topMover.startAutoRefresh();

        // Sync Baccarat threshold with current session leverage
        if (GS.maxLeverage > 0) {
            this.bigRoad.setThreshold(100 / GS.maxLeverage);
        }

        this.feed.on(d => this.onPrice(d));
        this.bindEvents();
        this.updateSeeds();
        this.loop();
    }

    // -- PRICE --
    onPrice(d) {
        // Dynamic Baccarat Threshold Sync
        const targetThr = 100 / (GS.maxLeverage || 100);
        if (Math.abs(this.bigRoad.threshold - targetThr) > 0.001) {
            this.bigRoad.setThreshold(targetThr);
        }

        // BigRoad 추적
        this.bigRoad.onPrice(d.price);

        // Ticker
        const tp = $('tickerPrice'); if (tp) tp.textContent = '$' + d.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const ce = $('tickerChange');
        ce.textContent = (d.change >= 0 ? '+' : '') + d.change.toFixed(2) + '%';
        ce.className = 'ticker-change ' + (d.change >= 0 ? 'up' : 'down');

        // Realtime price
        if (screens.realtime && screens.realtime.classList.contains('active')) {
            $('rtPrice').textContent = '$' + d.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const rc = $('rtChange');
            rc.textContent = (d.change >= 0 ? '+' : '') + d.change.toFixed(2) + '%';
            rc.className = 'rt-change ' + (d.change >= 0 ? 'up' : 'down');
        }

        // Plan price
        if (screens.plan.classList.contains('active')) {
            $('planPrice').textContent = '$' + d.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const pe = $('planChange');
            pe.textContent = (d.change >= 0 ? '+' : '') + d.change.toFixed(2) + '%';
            pe.className = 'plan-change ' + (d.change >= 0 ? 'up' : 'down');
        }

        // Game HUD updates
        if (GS.isRunning && GS.entryPrice > 0) {
            $('hudPrice').textContent = '$' + d.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

            const chg = ((d.price - GS.entryPrice) / GS.entryPrice * 100);
            let pnl;
            if (GS.direction === 'LONG') pnl = GS.balance * (chg / 100) * CFG.LEV;
            else pnl = GS.balance * (-chg / 100) * CFG.LEV;

            const isProfit = pnl >= 0;

            // PnL display
            const pa = $('pnlAmount');
            pa.textContent = (isProfit ? '+' : '-') + '₩' + Math.round(Math.abs(pnl)).toLocaleString();
            pa.className = 'pnl-amount ' + (isProfit ? 'profit' : 'loss');

            const effectivePct = GS.direction === 'LONG' ? chg : -chg;
            const pp = $('pnlPercent');
            pp.textContent = (effectivePct >= 0 ? '+' : '') + (effectivePct * CFG.LEV).toFixed(2) + '%';
            pp.className = 'pnl-percent ' + (isProfit ? 'profit' : 'loss');

            // TP/SL progress bars
            const tpDist = Math.abs(GS.tpPrice - GS.entryPrice);
            const slDist = Math.abs(GS.slPrice - GS.entryPrice);
            let tpProgress, slProgress;

            if (GS.direction === 'LONG') {
                tpProgress = Math.max(0, (d.price - GS.entryPrice) / tpDist);
                slProgress = Math.max(0, (GS.entryPrice - d.price) / slDist);
            } else {
                tpProgress = Math.max(0, (GS.entryPrice - d.price) / tpDist);
                slProgress = Math.max(0, (d.price - GS.entryPrice) / slDist);
            }
            $('tpFill').style.width = Math.min(tpProgress * 100, 100) + '%';
            $('slFill').style.width = Math.min(slProgress * 100, 100) + '%';

            // Game visual state
            const intensity = Math.min(Math.max(tpProgress, slProgress), 1);
            if (isProfit) {
                this.gameVis.setState('profit', intensity);
                document.body.className = 'state-profit';
                this.grav = -0.3 - intensity * 2;
            } else {
                this.gameVis.setState('loss', intensity);
                document.body.className = 'state-loss';
                this.grav = -0.3 + intensity * 2;
            }

            // Stage atmosphere
            if (GS.mode === 'LEGEND' && GS.currentStage >= 7) document.body.classList.add('state-critical');
        }
    }

    // -- EVENTS --
    bindEvents() {
        // Mode cards
        document.querySelectorAll('.mode-card').forEach(card => {
            card.addEventListener('click', () => {
                this.sfx.init(); this.sfx.play('click');
                document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                GS.mode = card.dataset.mode;
                // Go to plan screen
                setTimeout(() => this.showPlan(), 300);
            });
        });

        // Play mode toggle
        $('btnPractice').addEventListener('click', () => {
            GS.playMode = 'practice'; $('btnPractice').classList.add('active'); $('btnLive').classList.remove('active');
            $('apiConfig').style.display = 'none';
        });
        $('btnLive').addEventListener('click', () => {
            GS.playMode = 'live'; $('btnLive').classList.add('active'); $('btnPractice').classList.remove('active');
            $('apiConfig').style.display = 'block';
            this.loadApiKeys();
        });

        // API key save/delete
        $('btnSaveApi').addEventListener('click', () => this.saveApiKeys());
        $('btnDelApi').addEventListener('click', () => this.deleteApiKeys());

        $('seedInput').addEventListener('input', () => this.updateSeeds());

        // Go button (plan screen)
        $('btnGo').addEventListener('click', () => {
            if (GS.plan.some(d => d === null)) return;
            if (GS.playMode === 'live') {
                const k = $('apiKey').value.trim();
                const s = $('apiSecret').value.trim();
                if (!k || !s) { alert('실전 모드에는 API Key와 Secret이 필요합니다.'); return; }
            }
            this.sfx.play('start');
            this.startGame();
        });

        // Retry
        $('btnRetry').addEventListener('click', () => this.backToSelect());
        $('btnAgain').addEventListener('click', () => this.backToSelect());

        // Realtime mode
        $('btnRealtime').addEventListener('click', () => this.startRealtime());
        $('reserveToggle').addEventListener('click', () => {
            const m = $('reserveModes');
            m.classList.toggle('open');
            $('reserveArrow').textContent = m.classList.contains('open') ? '▲' : '▼';
        });
        $('rtBtnLong').addEventListener('click', () => this.rtPickDir('LONG'));
        $('rtBtnShort').addEventListener('click', () => this.rtPickDir('SHORT'));
        $('rtBtnGo').addEventListener('click', () => this.rtGo());
        $('rtBtnContinue').addEventListener('click', () => this.rtContinue());
        $('rtBtnStop').addEventListener('click', () => this.rtStop());
    }

    updateSeeds() {
        const s = parseInt($('seedInput').value) || 10000;
        $('easyExp').textContent = '₩' + (s * 8).toLocaleString();
        $('normalExp').textContent = '₩' + (s * 32).toLocaleString();
        $('legendExp').textContent = '₩' + (s * 1024).toLocaleString();
    }

    // -- API KEY MANAGEMENT (localStorage only) --
    loadApiKeys() {
        const k = localStorage.getItem('longshot_api_key');
        const s = localStorage.getItem('longshot_api_secret');
        const status = $('apiStatus');
        if (k && s) {
            $('apiKey').value = k;
            $('apiSecret').value = s;
            status.textContent = '✅ 저장된 API 키가 로드되었습니다';
            status.className = 'api-status saved';
        } else {
            status.textContent = '⚠️ 저장된 API 키가 없습니다';
            status.className = 'api-status empty';
        }
    }

    saveApiKeys() {
        const k = $('apiKey').value.trim();
        const s = $('apiSecret').value.trim();
        if (!k || !s) { alert('API Key와 Secret을 모두 입력하세요.'); return; }
        localStorage.setItem('longshot_api_key', k);
        localStorage.setItem('longshot_api_secret', s);
        const status = $('apiStatus');
        status.textContent = '✅ API 키가 브라우저에 저장되었습니다';
        status.className = 'api-status saved';
    }

    deleteApiKeys() {
        localStorage.removeItem('longshot_api_key');
        localStorage.removeItem('longshot_api_secret');
        $('apiKey').value = '';
        $('apiSecret').value = '';
        const status = $('apiStatus');
        status.textContent = '🗑️ API 키가 삭제되었습니다';
        status.className = 'api-status empty';
    }

    // -- SCREENS --
    showScreen(name) { Object.values(screens).forEach(s => s.classList.remove('active')); screens[name].classList.add('active'); }

    backToSelect() {
        this.cleanup();
        document.body.className = '';
        this.showScreen('select');
        document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
        GS.mode = null; GS.isRunning = false; GS.entryPrice = 0; GS.plan = [];
        this.confetti.stop(); this.legendFx.stop();
        $('legendOverlay').classList.remove('active');
    }

    // -- PLAN SCREEN --
    showPlan() {
        const cfg = CFG[GS.mode];
        const seed = parseInt($('seedInput').value) || 10000;

        GS.seed = seed;
        GS.plan = new Array(cfg.stages).fill(null);

        $('planMode').textContent = GS.mode + ' MODE';
        $('planSeed').textContent = '시드: ₩' + seed.toLocaleString();
        $('planPrice').textContent = GS.btcPrice > 0 ? '$' + GS.btcPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '연결 중...';

        // Generate slots
        const container = $('planSlots');
        container.innerHTML = '';

        // Calculate expected balance at each stage
        for (let i = 0; i < cfg.stages; i++) {
            const expectedBal = seed * Math.pow(2, i);
            const slot = document.createElement('div');
            slot.className = 'plan-slot';
            slot.id = `slot-${i}`;
            slot.innerHTML = `
                <div class="slot-num">STAGE <span>${i + 1}</span></div>
                <div class="slot-info">배팅: ₩${expectedBal.toLocaleString()}</div>
                <div class="slot-btns">
                    <button class="slot-btn long" data-idx="${i}" data-dir="LONG"><span class="slot-arrow">📈</span> LONG</button>
                    <button class="slot-btn short" data-idx="${i}" data-dir="SHORT"><span class="slot-arrow">📉</span> SHORT</button>
                </div>
            `;
            container.appendChild(slot);
        }

        // Bind slot buttons
        container.querySelectorAll('.slot-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.sfx.play('click');
                const idx = parseInt(btn.dataset.idx);
                const dir = btn.dataset.dir;
                GS.plan[idx] = dir;

                // Visual update
                const slot = $(`slot-${idx}`);
                slot.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('picked'));
                btn.classList.add('picked');
                slot.classList.add('done');

                this.updateGoButton();
            });
        });

        $('btnGo').disabled = true;
        $('btnGoText').textContent = '모든 단계를 선택하세요';

        this.showScreen('plan');
    }

    updateGoButton() {
        const allPicked = GS.plan.every(d => d !== null);
        $('btnGo').disabled = !allPicked;
        if (allPicked) {
            const summary = GS.plan.map((d, i) => `${i + 1}:${d}`).join(' → ');
            $('btnGoText').textContent = `전투 개시! (${summary})`;
        } else {
            const remaining = GS.plan.filter(d => d === null).length;
            $('btnGoText').textContent = `${remaining}개 단계 남음`;
        }
    }

    // -- START GAME --
    startGame() {
        if (GS.btcPrice === 0) {
            alert("실시간 코인 시세를 불러오는 중입니다. 잠시 후 다시 시도해주세요.");
            return;
        }

        const cfg = CFG[GS.mode];
        GS.balance = GS.seed;
        GS.totalStages = cfg.stages;
        GS.currentStage = 0;
        GS.isRunning = true;
        GS.entryPrice = 0;

        // Set API credentials if live mode (from localStorage or input fields)
        if (GS.playMode === 'live') {
            const key = localStorage.getItem('longshot_api_key') || $('apiKey').value.trim();
            const secret = localStorage.getItem('longshot_api_secret') || $('apiSecret').value.trim();
            this.futures.setCredentials(key, secret);
        }

        // HUD
        $('hudMode').textContent = GS.mode;
        this.updateBalance();
        this.createDots();

        this.showScreen('game');
        setTimeout(() => this.nextStage(), 800);
    }

    createDots() {
        const c = $('stageDots'); c.innerHTML = '';
        for (let i = 1; i <= GS.totalStages; i++) { const d = document.createElement('div'); d.className = 'stage-dot'; d.id = `dot-${i}`; c.appendChild(d); }
    }

    updateDots() {
        for (let i = 1; i <= GS.totalStages; i++) {
            const d = $(`dot-${i}`); if (!d) continue; d.className = 'stage-dot';
            if (i < GS.currentStage) d.classList.add('done');
            else if (i === GS.currentStage) d.classList.add('cur');
        }
    }

    updateBalance() {
        $('hudBalance').textContent = '₩' + Math.round(GS.balance).toLocaleString();
        if ($('hudBetLev')) $('hudBetLev').textContent = 'x' + GS.maxLeverage;
    }

    // -- STAGE --
    async nextStage() {
        if (!GS.isRunning) return;
        GS.currentStage++;

        if (GS.currentStage > GS.totalStages) { this.onVictory(); return; }

        $('hudStage').textContent = `STAGE ${GS.currentStage}/${GS.totalStages}`;
        this.updateDots();
        $('stageFill').style.width = ((GS.currentStage - 1) / GS.totalStages * 100) + '%';

        const direction = GS.plan[GS.currentStage - 1]; // 사전 선택된 방향
        const result = await this.runStage(direction);

        if (result === 'WIN') {
            this.sfx.play('win');
            this.gameVis.spawnBurst(true);
            await this.showResult(true);
            setTimeout(() => this.nextStage(), 1500);
        } else {
            this.sfx.play('lose');
            this.gameVis.spawnBurst(false);
            await this.showResult(false);
            setTimeout(() => this.onGameOver(), 1500);
        }
    }

    runStage(direction) {
        return new Promise(async (resolve) => {
            GS.direction = direction;
            GS.entryPrice = GS.btcPrice;

            if (direction === 'LONG') {
                GS.tpPrice = GS.entryPrice * (1 + CFG.TP / 100);
                GS.slPrice = GS.entryPrice * (1 - CFG.SL / 100);
            } else {
                GS.tpPrice = GS.entryPrice * (1 - CFG.TP / 100);
                GS.slPrice = GS.entryPrice * (1 + CFG.SL / 100);
            }

            // Update display
            const de = $('pnlDirection');
            de.textContent = direction; de.className = 'pnl-direction ' + direction.toLowerCase();
            $('pnlAmount').textContent = '₩0'; $('pnlAmount').className = 'pnl-amount';
            $('pnlPercent').textContent = '0.000%'; $('pnlPercent').className = 'pnl-percent';
            $('tpFill').style.width = '0%'; $('slFill').style.width = '0%';
            $('tpslEntry').textContent = '$' + GS.entryPrice.toFixed(2);

            // Reset rocket
            document.body.className = '';
            $('rocket').style.transform = '';

            // ★ LIVE MODE: 실제 바이낸스 주문 ★
            if (GS.playMode === 'live') {
                try {
                    // 진입 수량 계산 (시드 기준)
                    const usdtBalance = GS.balance / 1300; // KRW -> USDT approximate
                    const qty = (usdtBalance * CFG.LEV) / GS.btcPrice;

                    const result = await this.futures.openPosition(direction, qty, GS.entryPrice);
                    if (!result.success) {
                        console.error('주문 실패:', result.error);
                        alert('바이낸스 주문 실패: ' + JSON.stringify(result.error));
                        resolve('LOSE');
                        return;
                    }
                } catch (e) {
                    console.error('API 에러:', e);
                    alert('API 에러: ' + e.message);
                    resolve('LOSE');
                    return;
                }
            }

            // 실시간 가격으로 TP/SL 체크
            let settled = false;

            // Burst timer for visual effect
            this.burstTimer = setInterval(() => {
                if (!settled && GS.isRunning) {
                    const chg = ((GS.btcPrice - GS.entryPrice) / GS.entryPrice * 100);
                    const effectivePnl = GS.direction === 'LONG' ? chg : -chg;
                    if (Math.random() < 0.15) this.gameVis.spawnBurst(effectivePnl >= 0);
                }
            }, 800);

            this.priceCheckInterval = setInterval(async () => {
                if (settled) return;
                const cp = GS.btcPrice;

                let hit = null;
                if (direction === 'LONG') {
                    if (cp >= GS.tpPrice) hit = 'WIN';
                    else if (cp <= GS.slPrice) hit = 'LOSE';
                } else {
                    if (cp <= GS.tpPrice) hit = 'WIN';
                    else if (cp >= GS.slPrice) hit = 'LOSE';
                }

                if (hit) {
                    settled = true;
                    clearInterval(this.priceCheckInterval);
                    clearInterval(this.burstTimer);

                    // LIVE: 남은 주문 취소
                    if (GS.playMode === 'live') {
                        try { await this.futures.cancelAllOrders(); } catch (e) { console.warn('주문 취소 실패:', e); }
                    }

                    if (hit === 'WIN') {
                        GS.balance *= 2;
                    } else {
                        GS.balance = 0;
                    }
                    GS.entryPrice = 0;
                    resolve(hit);
                }
            }, 200);
        });
    }

    showResult(win) {
        return new Promise(resolve => {
            if (win) {
                $('srIcon').textContent = '🚀'; $('srTitle').textContent = `STAGE ${GS.currentStage} CLEAR!`;
                $('srTitle').className = 'sr-title win';
                $('srProfit').textContent = '+₩' + Math.round(GS.balance / 2).toLocaleString();
                $('srProfit').className = 'sr-profit win';
                $('srNext').textContent = GS.currentStage === GS.totalStages ? '🏆 최종 승리!' : `다음 단계로... (${GS.currentStage + 1}/${GS.totalStages})`;
            } else {
                $('srIcon').textContent = '💀'; $('srTitle').textContent = 'LIQUIDATED';
                $('srTitle').className = 'sr-title lose';
                $('srProfit').textContent = '-₩' + Math.round(GS.seed).toLocaleString();
                $('srProfit').className = 'sr-profit lose';
                $('srNext').textContent = '포지션이 청산되었습니다';
                const dot = $(`dot-${GS.currentStage}`); if (dot) dot.classList.add('fail');
            }
            this.updateBalance();
            $('stageResult').classList.add('active');
            setTimeout(() => { $('stageResult').classList.remove('active'); resolve(); }, 1600);
        });
    }

    onGameOver() {
        GS.isRunning = false; GS.entryPrice = 0; this.cleanup();
        $('goStage').textContent = `${GS.currentStage}/${GS.totalStages}`;
        $('goLoss').textContent = '-₩' + Math.round(GS.seed).toLocaleString();
        this.grav = 4; this.showScreen('over'); document.body.className = '';
    }

    onVictory() {
        GS.isRunning = false; GS.entryPrice = 0; this.cleanup();
        const rPct = ((GS.balance - GS.seed) / GS.seed * 100).toFixed(0);
        const mult = Math.round(GS.balance / GS.seed);
        $('winBalance').textContent = '₩' + Math.round(GS.balance).toLocaleString();
        $('winReturn').textContent = '+' + rPct + '%';
        $('winMult').textContent = '×' + mult;
        $('winMode').textContent = GS.mode + ' MODE';
        this.grav = -3; this.showScreen('win'); this.confetti.start(300); this.sfx.play('win');
        document.body.className = '';
        if (GS.mode === 'LEGEND') setTimeout(() => { $('legendOverlay').classList.add('active'); $('legendAmt').textContent = '₩' + Math.round(GS.balance).toLocaleString(); this.legendFx.start(); setTimeout(() => { $('legendOverlay').classList.remove('active'); this.legendFx.stop(); }, 7000); }, 2000);
        const ach = JSON.parse(localStorage.getItem('longshot_ach') || '[]'); ach.push({ mode: GS.mode, seed: GS.seed, bal: GS.balance, mult, date: new Date().toISOString() }); localStorage.setItem('longshot_ach', JSON.stringify(ach));
    }

    cleanup() {
        if (this.priceCheckInterval) { clearInterval(this.priceCheckInterval); this.priceCheckInterval = null; }
        if (this.burstTimer) { clearInterval(this.burstTimer); this.burstTimer = null; }
        $('stageResult').classList.remove('active');
        this.gameVis.setState('neutral', 0);
    }

    // -- RENDER LOOP --
    // ====== REALTIME MODE ======
    startRealtime() {
        const seed = parseInt($('seedInput').value) || 10000;
        GS.rtMode = true;
        GS.rtRound = 1;
        GS.rtDirection = null;
        GS.balance = seed;
        GS.seed = seed;
        GS.mode = 'EASY';
        GS.isRunning = false;
        GS.entryPrice = 0;
        if (GS.playMode === 'live') {
            const key = localStorage.getItem('longshot_api_key') || $('apiKey').value.trim();
            const secret = localStorage.getItem('longshot_api_secret') || $('apiSecret').value.trim();
            if (key && secret) this.futures.setCredentials(key, secret);
        }
        this.rtUpdateUI();
        this.showScreen('realtime');
    }
    rtUpdateUI() {
        $('rtRound').textContent = 'ROUND ' + GS.rtRound;
        $('rtBalance').textContent = '₩' + Math.round(GS.balance).toLocaleString();
        $('rtBtnLong').classList.remove('picked');
        $('rtBtnShort').classList.remove('picked');
        $('rtBtnGo').disabled = true;
        $('rtGoText').textContent = '방향을 선택하세요';
        GS.rtDirection = null;
        if (GS.btcPrice > 0) {
            $('rtPrice').textContent = '$' + GS.btcPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
    }
    rtPickDir(dir) {
        this.sfx.play('click');
        GS.rtDirection = dir;
        $('rtBtnLong').classList.toggle('picked', dir === 'LONG');
        $('rtBtnShort').classList.toggle('picked', dir === 'SHORT');
        $('rtBtnGo').disabled = false;
        $('rtGoText').textContent = dir + ' 진행! →';
    }
    async rtGo() {
        if (!GS.rtDirection) return;
        if (GS.btcPrice === 0) {
            alert("실시간 코인 시세를 불러오는 중입니다. 잠시 후 다시 시도해주세요.");
            return;
        }
        this.sfx.play('start');
        GS.totalStages = 1;
        GS.currentStage = 0;
        GS.plan = [GS.rtDirection];
        GS.isRunning = true;
        GS.entryPrice = 0;
        $('hudMode').textContent = '실시간';
        $('hudStage').textContent = 'ROUND ' + GS.rtRound;
        this.updateBalance();
        this.createDots();
        this.showScreen('game');
        setTimeout(async () => {
            GS.currentStage = 1;
            this.updateDots();
            $('stageFill').style.width = '0%';
            const result = await this.runStage(GS.rtDirection);
            if (result === 'WIN') {
                this.sfx.play('win');
                this.gameVis.spawnBurst(true);
                await this.showResult(true);
                setTimeout(() => {
                    $('rtResultIcon').textContent = '🎉';
                    $('rtResultTitle').textContent = 'ROUND ' + GS.rtRound + ' CLEAR!';
                    $('rtResultTitle').className = 'rt-result-title win';
                    $('rtResultProfit').textContent = '+₩' + Math.round(GS.balance / 2).toLocaleString();
                    $('rtResultProfit').className = 'rt-result-profit profit';
                    $('rtResultNext').textContent = '다음 라운드 배팅: ₩' + Math.round(GS.balance).toLocaleString();
                    $('rtBtnContinue').style.display = '';
                    $('rtResultModal').classList.add('active');
                }, 1500);
            } else {
                this.sfx.play('lose');
                this.gameVis.spawnBurst(false);
                await this.showResult(false);
                setTimeout(() => {
                    $('rtResultIcon').textContent = '💀';
                    $('rtResultTitle').textContent = 'ROUND ' + GS.rtRound + ' FAILED';
                    $('rtResultTitle').className = 'rt-result-title lose';
                    $('rtResultProfit').textContent = '-₩' + Math.round(GS.balance).toLocaleString();
                    $('rtResultProfit').className = 'rt-result-profit loss';
                    $('rtResultNext').textContent = '시드 금액을 잃었습니다';
                    $('rtBtnContinue').style.display = 'none';
                    $('rtResultModal').classList.add('active');
                }, 1500);
            }
        }, 800);
    }
    rtContinue() {
        $('rtResultModal').classList.remove('active');
        GS.rtRound++;
        GS.isRunning = false;
        GS.entryPrice = 0;
        this.cleanup();
        document.body.className = '';
        this.rtUpdateUI();
        this.showScreen('realtime');
    }
    rtStop() {
        $('rtResultModal').classList.remove('active');
        GS.rtMode = false;
        GS.isRunning = false;
        this.cleanup();
        document.body.className = '';
        if (GS.balance > GS.seed) {
            this.onVictory();
        } else {
            this.backToSelect();
        }
    }

    loop() {
        this.bg.draw(this.grav);
        this.gameVis.draw();
        this.confetti.draw();
        this.legendFx.draw();
        requestAnimationFrame(() => this.loop());
    }
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => { window.game = new Game(); });
