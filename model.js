import { LIGAS, TEAM_STRENGTH_DB, HOME_ADVANTAGE, CORNER_HOME_BIAS, CORNER_HOME_BIAS_LEAGUE } from './leagues.js';
import * as stats from './stats.js';
import { fetchLeagueDynamicData, fetchMatchPrediction } from './api.js';

const CACHE_TTL_MS = 60 * 60 * 1000;
const dynamicCache = {};

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

export function getTeamsForLeague(leagueKey) {
  const liga = LIGAS[leagueKey];
  if (liga?.compositeOf) {
    return liga.compositeOf.reduce(
      (acc, subKey) => ({ ...acc, ...(TEAM_STRENGTH_DB[subKey] || {}) }),
      {}
    );
  }
  return TEAM_STRENGTH_DB[leagueKey] || {};
}

function getTeamRating(leagueKey, teamName, dynamicRatings) {
  if (dynamicRatings?.[teamName]) return dynamicRatings[teamName];
  const rating = getTeamsForLeague(leagueKey)[teamName];
  if (!rating) {
      console.warn(`⚠️ ALERTA: Equipo "${teamName}" no encontrado. Usando rating por defecto 1.0`);
  }
  return rating || { atk: 1.0, def: 1.0 };
}

function blend(own, ml) {
  const w = typeof ml.confidence === 'number' ? Math.min(1, Math.max(0, ml.confidence)) : 0.5;
  const mix = (ownVal, mlVal) => {
    if (typeof mlVal !== 'number' || isNaN(mlVal)) return ownVal;
    return +((ownVal * (1 - w) + mlVal * w)).toFixed(1);
  };
  return {
    resultProbs: {
      local: mix(own.resultProbs.local, ml.resultProbs.local),
      empate: mix(own.resultProbs.empate, ml.resultProbs.empate),
      visitante: mix(own.resultProbs.visitante, ml.resultProbs.visitante),
    },
    over15: mix(own.over15, ml.over15),
    over25: mix(own.over25, ml.over25),
    btts: mix(own.btts, ml.btts),
  };
}

export async function simulateMatch(leagueKey, homeTeam, awayTeam, {
  staticOnly = false,
  calibracion = null,
} = {}) {
  const liga = LIGAS[leagueKey];
  if (!liga) throw new Error('Liga no encontrada');

  const dynamic = staticOnly ? null : await getDynamicData(leagueKey, liga.name);
  const goalsAvg = dynamic?.goalsAvg ?? liga.goalsAvg;
  const cornAvg = dynamic?.cornAvg ?? liga.cornAvg;

  const hRating = getTeamRating(leagueKey, homeTeam, dynamic?.teamRatings);
  const aRating = getTeamRating(leagueKey, awayTeam, dynamic?.teamRatings);

  // Calibración: si llega un objeto con homeAdvantage y/o rho, se usan esos
  // valores en vez de los de leagues.js. Esto permite que el backtest
  // (o cualquier llamador) imponga parámetros derivados del historial real.
  const homeAdv = calibracion?.homeAdvantage ?? HOME_ADVANTAGE[leagueKey] ?? 1.0;
  const rho = calibracion?.rho; // undefined = usar el de leagues.js

  const avgPerTeam = goalsAvg / 2;
  const lambdaHome = avgPerTeam * hRating.atk * aRating.def * homeAdv;
  const lambdaAway = avgPerTeam * aRating.atk * hRating.def;

  const resultProbs = stats.calcResultProbs(lambdaHome, lambdaAway, leagueKey, rho);
  const over15 = stats.over15DC(lambdaHome, lambdaAway, leagueKey, rho);
  const over25 = stats.poissonOver(lambdaHome + lambdaAway, 2.5);
  const over35 = stats.poissonOver(lambdaHome + lambdaAway, 3.5);
  const btts = stats.calcBTTS(lambdaHome, lambdaAway, leagueKey, rho);

  let cornerProbs = null;
  if (cornAvg && cornAvg > 0) {
    const cornBias = CORNER_HOME_BIAS_LEAGUE[leagueKey] ?? CORNER_HOME_BIAS;
    const { home: lCornerHome, away: lCornerAway } = stats.splitCornerLambda(
      cornAvg, hRating.atk, hRating.def, aRating.atk, aRating.def, cornBias
    );
    const totalCorners = lCornerHome + lCornerAway;
    const r = liga.cornR || 20;
    cornerProbs = {
      over7: stats.negBinOver(totalCorners, 7.5, r),
      over8: stats.negBinOver(totalCorners, 8.5, r),
      over9: stats.negBinOver(totalCorners, 9.5, r),
      porEquipo: {
        local: {
          esperado: lCornerHome,
          over3: stats.negBinOver(lCornerHome, 3.5, r),
          over4: stats.negBinOver(lCornerHome, 4.5, r),
        },
        visitante: {
          esperado: lCornerAway,
          over3: stats.negBinOver(lCornerAway, 3.5, r),
          over4: stats.negBinOver(lCornerAway, 4.5, r),
        }
      }
    };
  }

  const calLocal = stats.plattCalibrate(resultProbs.home, 'resultado');
  const calEmpate = stats.plattCalibrate(resultProbs.draw, 'resultado');
  const calVisitante = stats.plattCalibrate(resultProbs.away, 'resultado');
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
    over15: stats.plattCalibrate(over15, 'goals15'),
    over25: stats.plattCalibrate(over25, 'goals25'),
    over35,
    btts: stats.plattCalibrate(btts, 'btts'),
    cornerProbs
  };

  let bzzoiroML = null;
  if (dynamic?.bzzoiroLeagueId) {
    const pred = await fetchMatchPrediction(dynamic.bzzoiroLeagueId, homeTeam, awayTeam);
    if (pred?.markets) {
      bzzoiroML = {
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
      };
    }
  }

  const hasFullML = bzzoiroML
    && [bzzoiroML.resultProbs.local, bzzoiroML.resultProbs.empate, bzzoiroML.resultProbs.visitante, bzzoiroML.over15, bzzoiroML.over25, bzzoiroML.btts]
      .every(v => typeof v === 'number');

  return {
    ...ownResult,
    bzzoiroML,
    blended: hasFullML ? blend(ownResult, bzzoiroML) : null
  };
}
