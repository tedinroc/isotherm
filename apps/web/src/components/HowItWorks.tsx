import { useI18n } from '../i18n';
import { useApp } from '../state';
import { DEPLOYMENTS } from '../lib/deployments';
import { DEFAULT_CHALLENGE_WINDOW } from '../lib/data';
import { addrUrl } from '../config';
import { short } from '../lib/format';
import { OpenMeteoCredit } from './DataCredit';

interface Section {
  h: string;
  p: string[];
}

/** "15-minute" / "15 分鐘" for windows under an hour, "2-hour" / "2 小時" above (the live Resolver uses 900 s). */
export function windowLabel(seconds: number, lang: 'en' | 'zh'): string {
  if (seconds < 3600) {
    const m = Math.max(1, Math.round(seconds / 60));
    return lang === 'zh' ? `${m} 分鐘` : `${m}-minute`;
  }
  const h = Math.round((seconds / 3600) * 10) / 10;
  return lang === 'zh' ? `${h} 小時` : `${h}-hour`;
}

function content(lang: 'en' | 'zh', challengeSeconds: number): Section[] {
  const win = windowLabel(challengeSeconds, lang);
  if (lang === 'zh') {
    return [
      {
        h: '你在交易什麼',
        p: [
          '每張合約只問一件事：某機場官方的當日最高溫，會不會至少達到 k°C？「是」合約在達到時支付 1 AUSD，「否」合約在沒達到時支付 1 AUSD。一組「是＋否」永遠剛好價值 1 AUSD，全額存在金庫合約裡。',
          '最大損失＝你付出的金額（權利金）。沒有槓桿，沒有追繳保證金。',
        ],
      },
      {
        h: '結算規則（台北 = RCSS 松山機場）',
        p: [
          '當日最高溫 = 台北時間 00:00 到 24:00 之間，所有例行（:00、:30）與特別（SPECI）METAR 報告溫度組中最高的整數攝氏度。不另外四捨五入。',
          '這就是 Polymarket 台北每日最高溫市場所用的同一條規則：在 184 個以 RCSS 為準的台北日子中有 183 天與 Polymarket 結果相同（東京 RJTT 209/209）。唯一不同的那天（2026-05-04），兩個獨立的 METAR 資料庫（IEM 與 Ogimet）都有一筆 25°C 的報告，Polymarket 的 24°C 結果漏掉了它。',
        ],
      },
      {
        h: '誰來結算',
        p: [
          'Chainlink CRE 工作流程讀兩個公開資料來源（Iowa Environmental Mesonet、aviationweather.gov；Ogimet 為備援），套用上面的規則，再把結果連同營運者的 attestation 簽章送上鏈。目前經由 CRE 模擬 forwarder 送出，它不檢查發送者，所以簽章是必要的。',
          '結算在我們自己的機器上執行，不是由已部署的 Chainlink DON 執行：CRE 登入有效時用官方 CRE 模擬器，否則改用標明為備援的 SDK 測試工具（同一條規則、同一個簽章，但不是 CRE 引擎）。每次執行的證據紀錄都寫明用了哪一條路徑。v1 之前的兩個真實日子是在先前的可行性驗證合約上結算的：一次用從 MIT 授權 CRE CLI 原始碼編譯、只移除登入檢查的模擬器，一次用 SDK 測試工具。',
          challengeSeconds > 0
            ? `結果上鏈後有 ${win}挑戰期：期間守護者只能把結果改成「作廢」，不能改成別的溫度；挑戰期只適用於回報的溫度，回報「作廢」會立即生效。挑戰期結束後即可贖回。`
            : '結果上鏈後即可贖回。',
          '資料來源互相矛盾或不完整時，整個階梯作廢；逾時沒有報告，任何人都可以把它作廢。作廢時「是」和「否」各付 0.5 AUSD。',
        ],
      },
      {
        h: '價格從哪裡來（莊家是誰）',
        p: [
          'Isotherm 自己經營造市商，提供大部分流動性——也就是說，造市商就是莊家。它圍繞 Polymarket 隱含機率報價（把各溫度區間的價格正規化後加總）。',
          '我們自己的天氣模型只當作護欄顯示：回測中它不如 Polymarket 準，所以我們不宣稱有任何預測優勢。',
          '每個履約價都有自己的 Kuru 鏈上訂單簿。Kuru 收 0.1% 吃單手續費。Isotherm 無法暫停 Kuru 的訂單簿，造市商會在截止前撤單。',
        ],
      },
      {
        h: '坦白的風險',
        p: [
          '僅限測試網：這裡的 AUSD 是水龍頭發的免費測試幣，MON 是測試網手續費，都沒有真實價值。',
          '智能合約尚未經過正式審計。',
          '結算的信任錨是 attester 金鑰與 CRE 工作流程；若出錯，最壞情況是錯誤結算或作廢。',
          '這不是投資建議，也不是保險商品。',
        ],
      },
    ];
  }
  return [
    {
      h: 'What you are trading',
      p: [
        'Each contract asks one question: will the official daily maximum temperature at an airport station be at least k °C on that local day? A Yes contract pays 1 AUSD if it is; a No contract pays 1 AUSD if it is not. A Yes + No pair is always worth exactly 1 AUSD, fully held in the vault contract.',
        'Max loss = what you pay (the premium). No leverage, no margin calls.',
      ],
    },
    {
      h: 'The settlement rule (Taipei = RCSS, Songshan Airport)',
      p: [
        'Daily max = the highest whole-degree °C in the METAR temperature group across all routine (:00 and :30) and special (SPECI) reports from 00:00 to 24:00 Taipei time. No further rounding.',
        'This is the rule Polymarket’s Taipei daily-high markets resolve on: it matches Polymarket on 183 of 184 station-sourced Taipei days (Tokyo RJTT: 209/209). On the one miss (2026-05-04), two independent METAR archives (IEM and Ogimet) both hold a 25 °C report that Polymarket’s 24 °C result missed.',
      ],
    },
    {
      h: 'Who settles',
      p: [
        'A Chainlink CRE workflow reads two public archives (Iowa Environmental Mesonet and aviationweather.gov, with Ogimet as fallback), applies the rule, and reports the result on-chain with an operator attestation signature. For now it goes through the CRE simulation forwarder, which does not check who calls it — that is why the signature is mandatory.',
        'Settlement runs on our own machine, not on a deployed Chainlink DON: through the official CRE simulator when our CRE login is active, otherwise through a labelled SDK test-harness fallback (same rule and signature, not the CRE engine). Each run’s evidence record names the path it used. Before v1, two real days were settled on our earlier feasibility contracts: one by a simulator built from the MIT CRE CLI source with only its login check removed, one by the SDK harness.',
        challengeSeconds > 0
          ? `After a report there is a ${win} challenge window in which the guardian can only turn the result into a void (never into a different temperature); it applies to a reported temperature, while a reported void is final at once. Redemption opens when it ends.`
          : 'Redemption opens as soon as the result is on-chain.',
        'If the sources disagree or are incomplete, the whole ladder is void; if no report arrives in time, anyone can void it. Void pays 0.5 AUSD per Yes and 0.5 AUSD per No.',
      ],
    },
    {
      h: 'Where prices come from (who is the house)',
      p: [
        'Isotherm runs the market maker that provides most of the liquidity — the maker is the house. It quotes around the Polymarket-implied probability (bucket prices normalised and summed).',
        'Our own weather model is shown only as a guardrail: in backtest it is less accurate than Polymarket, so we make no forecasting-edge claim.',
        'Every strike has its own Kuru on-chain order book. Kuru charges a 0.1% taker fee. Isotherm cannot pause a Kuru book; the maker pulls its quotes before close.',
      ],
    },
    {
      h: 'Honest risks',
      p: [
        'Testnet only: AUSD here is free faucet test money and MON is testnet gas. Nothing on this app has real value.',
        'The smart contracts are not audited.',
        'The trust anchors for settlement are the attester key and the CRE workflow; if they fail, the worst case is a wrong result or a void.',
        'This is not investment advice or an insurance product.',
      ],
    },
  ];
}

export function HowItWorks() {
  const { t, lang } = useI18n();
  const { caps } = useApp();
  const sections = content(lang, caps?.challengeWindow ?? DEFAULT_CHALLENGE_WINDOW);
  return (
    <div className="screen">
      <section className="card how">
        <h2 className="card-title">{t('how.title')}</h2>
        {sections.map((s) => (
          <div key={s.h} className="how-sec">
            <h3>{s.h}</h3>
            {s.p.map((p) => (
              <p key={p.slice(0, 24)}>{p}</p>
            ))}
          </div>
        ))}
        <div className="how-sec">
          <h3>{lang === 'zh' ? '資料來源' : 'Data sources'}</h3>
          <p>
            {lang === 'zh' ? '結算觀測：' : 'Settlement observations: '}
            <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noreferrer">
              Iowa Environmental Mesonet
            </a>
            {', '}
            <a href="https://aviationweather.gov/" target="_blank" rel="noreferrer">
              aviationweather.gov
            </a>
            {lang === 'zh' ? '，備援 ' : ', fallback '}
            <a href="https://www.ogimet.com/" target="_blank" rel="noreferrer">
              Ogimet
            </a>
            {lang === 'zh' ? '。參考價格：Polymarket 公開市場資料（與 Isotherm 無關聯）。' : '. Reference prices: Polymarket public market data (not affiliated with Isotherm).'}
          </p>
          <OpenMeteoCredit lang={lang} />
        </div>
        <div className="how-sec">
          <h3>{lang === 'zh' ? '合約地址（Monad 測試網 10143）' : 'Contracts (Monad testnet 10143)'}</h3>
          <dl className="kv">
            <dt>Vault</dt>
            <dd>
              <a className="mono" href={addrUrl(DEPLOYMENTS.vault)} target="_blank" rel="noreferrer">
                {short(DEPLOYMENTS.vault)}
              </a>
            </dd>
            <dt>Resolver</dt>
            <dd>
              <a className="mono" href={addrUrl(DEPLOYMENTS.resolver)} target="_blank" rel="noreferrer">
                {short(DEPLOYMENTS.resolver)}
              </a>
            </dd>
            <dt>Zap</dt>
            <dd>
              <a className="mono" href={addrUrl(DEPLOYMENTS.zap)} target="_blank" rel="noreferrer">
                {short(DEPLOYMENTS.zap)}
              </a>
            </dd>
            <dt>AUSD</dt>
            <dd>
              <a className="mono" href={addrUrl(DEPLOYMENTS.ausd)} target="_blank" rel="noreferrer">
                {short(DEPLOYMENTS.ausd)}
              </a>
            </dd>
          </dl>
          {DEPLOYMENTS.source === 'feasibility-fallback' && (
            <p className="fine">{lang === 'zh' ? '目前指向可行性驗證部署（v1 尚未部署）。' : 'Pointing at the feasibility deployment (v1 not deployed yet).'}</p>
          )}
        </div>
      </section>
    </div>
  );
}
