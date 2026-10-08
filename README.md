# Suertudo

Simulador de partidos de fútbol (goles, 1X2, BTTS, córners) con Poisson / Dixon-Coles / binomial negativa, datos en vivo de la API de Bzzoiro y calibración propia por liga.

## Modelo v2 (MODEL_VERSION = 2)

- **Goles esperados**: `λ local = base·√HA`, `λ visita = base/√HA`. HA es el cociente goles local / visitante. El total del partido promedia el `goalsAvg` de la liga (antes se inflaba hasta ~15%).
- **Ratings estáticos** (`TEAM_STRENGTH_DB`): se normalizan a media 1.0 y se encogen levemente (`RATING_SHRINK`).
- **Datos en vivo**: se mezclan con el rating estático según partidos jugados (`LIVE_PRIOR_GAMES`). Los nombres de equipos se emparejan aunque difieran ("Ajax" / "AFC Ajax").
- **Dixon-Coles seguro**: rho se limita al rango válido para cada partido; todos los mercados de goles salen de la misma grilla de marcadores.
- **Calibración** (`calibrate.js`): HA y rho por máxima verosimilitud sobre marcadores reales, con prior hacia `leagues.js` y hold-out cronológico. Solo se aceptan si no empeoran de forma significativa en los partidos recientes.
- **Picks** (`picks.js`): usa los mismos umbrales por liga, filtro y shrinkage que el backtest.
- **Versionado**: los parámetros guardados con otra versión del modelo se ignoran.

## Flujo de trabajo

1. `export-historial.html` → descargá el historial de la liga.
2. `backtest.html` → cargalo y corré el backtest (calibra y guarda en el dispositivo).
3. "Descargar params.json" y subilo al repo.
4. `recalcular-ratings.html` → ratings ajustados por rival para pegar en `TEAM_STRENGTH_DB`.

> Los semáforos `betting` (verde/amarillo/rojo) de `leagues.js` se midieron con el modelo v1. Volvé a correr el backtest de cada liga antes de confiar en ellos.
