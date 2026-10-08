// ============================================================================
// MODELO ESTADÍSTICO (Poisson, binomial negativa, Dixon-Coles, calibración Platt)
// ============================================================================

import { PLATT_PARAMS, DIXON_COLES_RHO } from './leagues.js';

// ========== FUNCIONES MATEMÁTICAS ==========
export function plattCalibrate(raw, type) {
    const p = Math.max(0.001, Math.min(0.999, raw / 100));
    const logit = Math.log(p / (1 - p));
    const params = PLATT_PARAMS[type] || { A: 0.93, B: -0.04 };
    const calibrated = 1 / (1 + Math.exp(-(params.A * logit + params.B)));
    return Math.min(98, Math.max(2, calibrated * 100));
}

export function poissonExact(lambda, k) { 
    if (k < 0) return 0;
    if (k === 0) return Math.exp(-lambda);
    let t = Math.exp(-lambda); 
    for (let i = 0; i < k; i++) t *= lambda / (i + 1); 
    return t; 
}

export function poissonProb(lambda, k) { 
    let p = Math.exp(-lambda), t = p; 
    for (let i = 1; i <= k; i++) { t *= lambda / i; p += t; } 
    return p; 
}

export function poissonOver(lambda, th) { 
    return Math.min(98, Math.max(2, (1 - poissonProb(lambda, Math.floor(th))) * 100)); 
}

export function over15DC(lH, lA, leagueKey, rhoOverride) {
    const rho = rhoOverride ?? DIXON_COLES_RHO[leagueKey] ?? DIXON_COLES_RHO.default;
    const p00 = poissonExact(lH, 0) * poissonExact(lA, 0) * dixonColesTau(0, 0, lH, lA, rho);
    const p10 = poissonExact(lH, 1) * poissonExact(lA, 0) * dixonColesTau(1, 0, lH, lA, rho);
    const p01 = poissonExact(lH, 0) * poissonExact(lA, 1) * dixonColesTau(0, 1, lH, lA, rho);
    return Math.min(98, Math.max(2, (1 - (p00 + p10 + p01)) * 100));
}

export function negBinExact(mu, r, k) {
    if (k < 0) return 0;
    if (k === 0) return Math.pow(r / (r + mu), r);
    const p = r / (r + mu);
    let logComb = 0;
    for (let i = 1; i <= k; i++) {
        logComb += Math.log(r + i - 1) - Math.log(i);
    }
    const logP = logComb + r * Math.log(p) + k * Math.log(1 - p);
    return Math.exp(logP);
}

export function negBinOver(mu, th, r) { 
    const k = Math.floor(th); 
    let cdf = 0; 
    for (let i = 0; i <= k; i++) cdf += negBinExact(mu, r, i); 
    return Math.min(98, Math.max(2, (1 - cdf) * 100)); 
}

export function dixonColesTau(x, y, lH, lA, rho) { 
    if (x === 0 && y === 0) return 1 - (lH * lA * rho);
    if (x === 0 && y === 1) return 1 + (lH * rho);
    if (x === 1 && y === 0) return 1 + (lA * rho);
    if (x === 1 && y === 1) return 1 - rho;
    return 1; 
}

export function calcBTTS(lH, lA, leagueKey, rhoOverride) { 
    const rho = rhoOverride ?? DIXON_COLES_RHO[leagueKey] ?? DIXON_COLES_RHO.default; 
    const p00 = poissonExact(lH, 0) * poissonExact(lA, 0) * dixonColesTau(0, 0, lH, lA, rho);
    const pHome0 = poissonExact(lH, 0);
    const pAway0 = poissonExact(lA, 0);
    const btts = 1 - pHome0 - pAway0 + p00;
    return Math.min(98, Math.max(2, btts * 100)); 
}

export function calcResultProbs(lH, lA, leagueKey, rhoOverride) { 
    const rho = rhoOverride ?? DIXON_COLES_RHO[leagueKey] ?? DIXON_COLES_RHO.default; 
    let pH = 0, pD = 0, pA = 0, total = 0; 
    for (let h = 0; h <= 10; h++) { 
        for (let a = 0; a <= 10; a++) { 
            let p = poissonExact(lH, h) * poissonExact(lA, a); 
            if (h <= 1 && a <= 1) p *= dixonColesTau(h, a, lH, lA, rho); 
            total += p;
            if (h > a) pH += p; 
            else if (h === a) pD += p; 
            else pA += p; 
        } 
    }
    const sum = (pH + pD + pA) || 1;
    return { home: +((pH / sum) * 100).toFixed(1), draw: +((pD / sum) * 100).toFixed(1), away: +((pA / sum) * 100).toFixed(1) }; 
}

export function colorFor(p) { return p >= 65 ? 'var(--green)' : p >= 42 ? 'var(--yellow)' : 'var(--accent)'; }
export function cardClassFor(p) { return p >= 65 ? 'high' : p >= 42 ? 'mid' : 'low'; }

export function normalizeCornersAvg(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

export function splitCornerLambda(totalCorners, homeAtk, homeDef, awayAtk, awayDef, homeBias) {
    const homeShareBase = homeBias / (homeBias + 1);
    const homeFactor = (homeAtk + awayDef) / 2;
    const awayFactor = (awayAtk + homeDef) / 2;
    const home = +(totalCorners * homeShareBase * homeFactor).toFixed(2);
    const away = +(totalCorners * (1 - homeShareBase) * awayFactor).toFixed(2);
    return { home, away };
}
