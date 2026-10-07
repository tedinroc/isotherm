# Data notice

The code in this repository is licensed as described in [LICENSE](LICENSE). Some committed files also contain **third-party data**: forecasts, weather observations and market prices that were fetched, cached or derived while building and testing Isotherm. That data keeps its source's terms, listed below.

## Open-Meteo (forecasts): CC BY 4.0

[Weather data by Open-Meteo.com](https://open-meteo.com/), licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

**Changes made.** Isotherm's v0 model (`packages/forecast/src/openmeteo.ts`, `packages/forecast/src/v0.ts`, and the earlier `spikes/weather`) combines Open-Meteo's multi-model forecasts, bias-corrects them against past station observations and turns them into "Tmax ≥ k °C" probabilities. The values in this repository and in the app are these **modified** values, not Open-Meteo's raw output.

**Where it appears.**
- The web app shows it as the "Model" figure on each strike. Web builds from this tree credit Open-Meteo next to those figures and in "How it works" (`apps/web/src/components/DataCredit.tsx`).
- Committed files with Open-Meteo-derived values (`v0`, `model`, `guard` or `modelSpread` fields): `packages/forecast/results/live_*.json`, `spikes/weather/results/` (backtest and live files), `spikes/e2e/logs/*/state.json` and `summary.json`, maker snapshots in `packages/maker/evidence/`, `packages/maker/examples/snapshot.example.json` and `docs/evidence/golive/snapshot-*.json`, and `spikes/verify/logs/mm-weather-quote.json`.

Open-Meteo's free API is for non-commercial use. A commercial deployment would need an Open-Meteo API subscription.

## Weather observations (METAR) used for settlement and fidelity checks

| Source | Terms |
|---|---|
| [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) (Iowa State University), ASOS/METAR archive | Freely available public archive; credited here as the IEM asks. Requests are cached and rate-limited. |
| [aviationweather.gov](https://aviationweather.gov/) Data API (NOAA / NWS Aviation Weather Center) | U.S. Government data; observe the API's usage limits. |
| [Ogimet](https://www.ogimet.com/) | Raw WMO METAR reports retrieved through Ogimet, used only as a fallback and queried gently. |

Files: `spikes/weather/data/` (daily maxima from IEM and Ogimet), `spikes/weather/results/` (`fidelity_*`, `ogimet_check.json`, `source_agreement.json`), captured responses in `packages/cre-workflow/settle/fixtures/` and `spikes/weather/test/fixtures/`, and the settlement evidence logs.

## Market prices

Polymarket prices and resolutions come from Polymarket's public Gamma and CLOB APIs, read-only, and remain subject to [Polymarket's Terms of Use](https://polymarket.com/tos). Isotherm sends no orders to Polymarket and is not affiliated with it. They appear in `spikes/weather/data/pm_ladders_*.json`, the fidelity and forecast results, maker snapshots and evidence logs.
