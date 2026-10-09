import {
  LIGAS, TEAM_STRENGTH_DB, HOME_ADVANTAGE, CORNER_HOME_BIAS, CORNER_HOME_BIAS_LEAGUE,
  DEFAULT_HOME_ADV, HA_MIN, HA_MAX,
  RATING_SHRINK, RATING_MIN, RATING_MAX,
  LIVE_PRIOR_GAMES, GOALS_AVG_PRIOR_MATCHES, ML_MAX_WEIGHT,
} from './leagues.js';
import * as stats from './stats.js';
import { fetchLeagueDynamicData, fetchMatchPrediction, buscarEquipoEn } from './api.js';

const CACHE_TTL_MS = 60 * 60 * 1000;
const dynamicCache = {};
const LAMBDA_MIN = 0.12, LAMBDA_MAX = 4.2;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

async function getDynamicData(leagueKey, leagueDisplayName) {
  const now = Date.now();
  if (dynamicCache[leagueKey] && (now - dynamicCache[leagueKey].timestamp < CACHE_TTL_MS)) {
    return dynamicCache[leagueKey].data;
  }
  try {
    const data = await fetchLeagueDynamicData(leagueKey, leagueDisplayName);
    dynamicCache[leagueKey] = { data, timestamp: now };
    return data;
  } catch (e) {
    console.warn('Fallback a datos estáticos:', e.message);
    return dynamicCache[leagueKey]?.data || null;
  }
}

// ============ RATINGS ESTÁTICOS (normalizados) ============
// Los ratings de leagues.js se reescalan para que la media de ataque y de
// defensa de la liga sea exactamente 1.0 (así lambdaLocal + lambdaVisita
// promedia el goalsAvg de la liga) y se acercan un poco a 1.0 para frenar
// valores extremos (muestras chicas).
const normCache = {};

function normalizarSubLiga(subKey) {
  if (normCache[subKey]) return normCache[subKey];
  const raw = TEAM_STRENGTH_DB[subKey] || {};
  const nombres = Object.keys(raw);
  const out = {};
  if (nombres.length > 0) {
    const mAtk = nombres.reduce((s, n) => s + raw[n].atk, 0) / nombres.length;
    const mDef = nombres.reduce((s, n) => s + raw[n].def, 0) / nombres.length;
    const ajustar = (r) => clamp(1 + RATING_SHRINK * (r - 1), RATING_MIN, RATING_MAX);
    for (const n of nombres) {
      out[n] = { atk: +ajustar(raw[n].atk / mAtk).toFixed(4), def: +ajustar(raw[n].def / mDef).toFixed(4) };
    }
  }
  normCache[subKey] = out;
  return out;
}

export function getTeamsForLeague(leagueKey) {
  const liga = LIGAS[leagueKey];
  if (liga?.compositeOf) {
    return liga.compositeOf.reduce(
      (acc, subKey) => ({ ...acc, ...normalizarSubLiga(subKey) }),
      {}
    );
  }
  return normalizarSubLiga(leagueKey);
}

// Rating estático normalizado de un equipo (o null si no existe).
export function getStaticRating(leagueKey, teamName) {
  const teams = getTeamsForLeague(leagueKey);
  return teams[teamName] || buscarEquipoEn(teams, teamName) || null;
}

// Rating final = prior estático + evidencia en vivo, ponderada por partidos jugados.
function getTeamRating(leagueKey, teamName, dynamicRatings) {
  const estatico = getStaticRating(leagueKey, teamName);
  const vivo = buscarEquipoEn(dynamicRatings, teamName);

  if (!estatico && !vivo) {
    console.warn(`⚠️ ALERTA: Equipo "${teamName}" no encontrado. Usando rating por defecto 1.0`);
    return { atk: 1.0, def: 1.0 };
  }
  const prior = estatico || { atk: 1.0, def: 1.0 };
  if (!vivo) return prior;

  const w = vivo.played / (vivo.played + LIVE_PRIOR_GAMES);
  return {
    atk: clamp(w * vivo.atk + (1 - w) * prior.atk, RATING_MIN, RATING_MAX),
    def: clamp(w * vivo.def + (1 - w) * prior.def, RATING_MIN, RATING_MAX),
  };
}

// Promedio de goles por partido: prior (calibrado o estático) + datos en vivo.
function resolverGoalsAvg(liga, dynamic, calibracion) {
  const prior = Number.isFinite(calibracion?.goalsAvg) ? calibracion.goalsAvg : liga.goalsAvg;
  if (!dynamic?.goalsAvg || !dynamic.totalPlayed) return prior;
  const partidosVivo = dynamic.totalPlayed / 2; // totalPlayed cuenta cada partido dos veces
  return (partidosVivo * dynamic.goalsAvg + GOALS_AVG_PRIOR_MATCHES * prior) / (partidosVivo + GOALS_AVG_PRIOR_MATCHES);
}

// ============ LAMBDAS (usado también por la calibración) ============
// HA = cociente goles local / goles visitante. Se reparte en forma simétrica
// para que el TOTAL esperado siga siendo ~goalsAvg (antes se inflaba).
export function calcLambdas(goalsAvg, hRating, aRating, homeAdv) {
  const avgPerTeam = goalsAvg / 2;
  const ha = clamp(homeAdv, HA_MIN, HA_MAX);
  const sq = Math.sqrt(ha);
  return {
    lambdaHome: clamp(avgPerTeam * hRating.atk * aRating.def * sq, LAMBDA_MIN, LAMBDA_MAX),
    lambdaAway: clamp(avgPerTeam * aRating.atk * hRating.def / sq, LAMBDA_MIN, LAMBDA_MAX),
  };
}

// ============ ML DE BZZOIRO ============
// Normaliza cada campo POR SEPARADO. Antes se decidía si venían en fracción o
// en porcentaje mirando la suma de resultProbs y esa decisión se aplicaba a
// TODOS los campos, lo que rompía si la API devolvía, por ejemplo, el 1X2 en
// porcentaje pero over/btts en fracción (o al revés).
function normalizarML(ml) {
  const rp = ml.resultProbs || {};

  const toPct = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    // 0..1.5 => fracción (0.45 -> 45). Cualquier otro valor => ya es porcentaje.
    return v <= 1.5 ? +(v * 100).toFixed(1) : +v.toFixed(1);
  };

  let conf = ml.confidence;
  if (typeof conf === 'number' && conf > 1) conf = conf / 100;

  return {
    resultProbs: {
      local: toPct(rp.local),
      empate: toPct(rp.empate),
      visitante: toPct(rp.visitante),
    },
    over15: toPct(ml.over15),
    over25: toPct(ml.over25),
    over35: toPct(ml.over35),
    btts: toPct(ml.btts),
    confidence: typeof conf === 'number' && Number.isFinite(conf) ? conf : null,
  };
}

function blend(own, ml) {
  const confianza = typeof ml.confidence === 'number' ? ml.confidence : 0.5;
  const w = clamp(confianza, 0, ML_MAX_WEIGHT);
  const mix = (ownVal, mlVal) => {
    if (typeof mlVal !== 'number' || isNaN(mlVal)) return ownVal;
    return +((ownVal * (1 - w) + mlVal * w)).toFixed(1);
  };
  let L = mix(own.resultProbs.local, ml.resultProbs.local);
  let E = mix(own.resultProbs.empate, ml.resultProbs.empate);
  let V = mix(own.resultProbs.visitante, ml.resultProbs.visitante);
  const s = L + E + V;
  if (s > 0) { L = +(L / s * 100).toFixed(1); E = +(E / s * 100).toFixed(1); V = +(V / s * 100).toFixed(1); }
  return {
    resultProbs: { local: L, empate: E, visitante: V },
    over15: mix(own.over15, ml.over15),
    over25: mix(own.over25, ml.over25),
    over35: mix(own.over35, ml.over35),
    btts: mix(own.btts, ml.btts),
    pesoML: w,
  };
}

// ============ SIMULACIÓN ============
export async function simulateMatch(leagueKey, homeTeam, awayTeam, {
  staticOnly = false,
  calibracion = null,
} = {}) {
  const liga = LIGAS[leagueKey];
  if (!liga) throw new Error('Liga no encontrada');

  const dynamic = staticOnly ? null : await getDynamicData(leagueKey, liga.name);
  const goalsAvg = resolverGoalsAvg(liga, dynamic, calibracion);
  const cornAvg = dynamic?.cornAvg ?? liga.cornAvg;

  const hRating = getTeamRating(leagueKey, homeTeam, dynamic?.teamRatings);
  const aRating = getTeamRating(leagueKey, awayTeam, dynamic?.teamRatings);

  // Si llega una calibración con homeAdvantage/rho se usa esa; si no, leagues.js.
  const homeAdv = calibracion?.homeAdvantage ?? HOME_ADVANTAGE[leagueKey] ?? DEFAULT_HOME_ADV;
  const rho = calibracion?.rho; // undefined = usar el de leagues.js

  const { lambdaHome, lambdaAway } = calcLambdas(goalsAvg, hRating, aRating, homeAdv);

  // Todos los mercados de goles salen de la misma grilla Dixon-Coles.
  const mk = stats.calcGoalMarkets(lambdaHome, lambdaAway, leagueKey, rho);

  let cornerProbs = null;
  if (cornAvg && cornAvg > 0) {
    const cornBias = CORNER_HOME_BIAS_LEAGUE[leagueKey] ?? CORNER_HOME_BIAS;
    const { home: lCornerHome, away: lCornerAway } = stats.splitCornerLambda(
      cornAvg, hRating.atk, hRating.def, aRating.atk, aRating.def, cornBias
    );
    const totalCorners = lCornerHome + lCornerAway;
    const r = liga.cornR || 20;
    const pc = (v) => stats.plattCalibrate(v, 'corners');
    cornerProbs = {
      over7: pc(stats.negBinOver(totalCorners, 7.5, r)),
      over8: pc(stats.negBinOver(totalCorners, 8.5, r)),
      over9: pc(stats.negBinOver(totalCorners, 9.5, r)),
      porEquipo: {
        local: {
          esperado: lCornerHome,
          over3: pc(stats.negBinOver(lCornerHome, 3.5, r)),
          over4: pc(stats.negBinOver(lCornerHome, 4.5, r)),
        },
        visitante: {
          esperado: lCornerAway,
          over3: pc(stats.negBinOver(lCornerAway, 3.5, r)),
          over4: pc(stats.negBinOver(lCornerAway, 4.5, r)),
        }
      }
    };
  }

  const calLocal = stats.plattCalibrate(mk.resultProbs.home, 'resultado');
  const calEmpate = stats.plattCalibrate(mk.resultProbs.draw, 'resultado');
  const calVisitante = stats.plattCalibrate(mk.resultProbs.away, 'resultado');
  const sumaCal = calLocal + calEmpate + calVisitante;

  const ownResult = {
    liga: liga.name,
    homeTeam,
    awayTeam,
    resultProbs: {
      local: +(calLocal * 100 / sumaCal).toFixed(1),
      empate: +(calEmpate * 100 / sumaCal).toFixed(1),
      visitante: +(calVisitante * 100 / sumaCal).toFixed(1),
    },
    over15: stats.plattCalibrate(mk.over15, 'goals15'),
    over25: stats.plattCalibrate(mk.over25, 'goals25'),
    over35: stats.plattCalibrate(mk.over35, 'goals35'),
    btts: stats.plattCalibrate(mk.btts, 'btts'),
    cornerProbs,
    lambdas: { local: +lambdaHome.toFixed(3), visitante: +lambdaAway.toFixed(3) },
  };

  let bzzoiroML = null;
  if (dynamic?.bzzoiroLeagueId) {
    const pred = await fetchMatchPrediction(dynamic.bzzoiroLeagueId, homeTeam, awayTeam);
    if (pred?.markets) {
      bzzoiroML = normalizarML({
        resultProbs: {
          local: pred.markets.match_result?.prob_home,
          empate: pred.markets.match_result?.prob_draw,
          visitante: pred.markets.match_result?.prob_away,
        },
        over15: pred.markets.over_under?.prob_over_15,
        over25: pred.markets.over_under?.prob_over_25,
        over35: pred.markets.over_under?.prob_over_35,
        btts: pred.markets.btts?.prob_yes,
        confidence: pred.model?.confidence ?? null,
      });
    }
  }

  const hasFullML = bzzoiroML
    && [bzzoiroML.resultProbs.local, bzzoiroML.resultProbs.empate, bzzoiroML.resultProbs.visitante, bzzoiroML.over15, bzzoiroML.over25, bzzoiroML.btts]
      .every(v => typeof v === 'number' && Number.isFinite(v));

  return {
    ...ownResult,
    bzzoiroML,
    blended: hasFullML ? blend(ownResult, bzzoiroML) : null
  };
}
