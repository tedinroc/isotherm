/** CC BY 4.0 attribution for the "Model" figures (Isotherm's bias-corrected v0 model built on Open-Meteo forecasts). */
export function OpenMeteoCredit({ lang }: { lang: 'en' | 'zh' }) {
  const om = (
    <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
      Open-Meteo.com
    </a>
  );
  const cc = (
    <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
      CC BY 4.0
    </a>
  );
  return lang === 'zh' ? (
    <p className="fine" data-testid="open-meteo-credit">
      「模型」以 Open-Meteo 預報為基礎，經 Isotherm 偏差校正（已修改）。天氣資料來自 {om}（{cc}）。
    </p>
  ) : (
    <p className="fine" data-testid="open-meteo-credit">
      “Model” is built from Open-Meteo forecasts, bias-corrected by Isotherm (modified). Weather data by {om} ({cc}).
    </p>
  );
}
