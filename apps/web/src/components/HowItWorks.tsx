import { useI18n } from '../i18n';
import { useApp } from '../state';
import { DEPLOYMENTS } from '../lib/deployments';
import { addrUrl } from '../config';
import { short } from '../lib/format';

interface Section {
  h: string;
  p: string[];
}

function content(lang: 'en' | 'zh', challengeHours: number): Section[] {
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
          '這就是 Polymarket 台北每日最高溫市場所用的同一條規則：在 184 個以 RCSS 為準的台北日子中有 183 天與 Polymarket 結果相同（東京 RJTT 209/209）。唯一不同的那天，三個 METAR 資料庫都顯示是 Polymarket 的結算方漏了一筆報告。',
        ],
      },
      {
        h: '誰來結算',
        p: [
          'Chainlink CRE 工作流程讀兩個公開資料來源（Iowa Environmental Mesonet、aviationweather.gov；Ogimet 為備援），套用上面的規則，再把結果連同營運者的 attestation 簽章送上鏈。目前用的是 CRE 模擬 forwarder，它不檢查發送者，所以簽章是必要的。',
          challengeHours > 0
            ? `結果上鏈後有 ${challengeHours} 小時挑戰期：期間守護者只能把結果改成「作廢」，不能改成別的溫度。挑戰期結束後即可贖回。`
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
        'This is the rule Polymarket’s Taipei daily-high markets resolve on: it matches Polymarket on 183 of 184 station-sourced Taipei days (Tokyo RJTT: 209/209). On the one miss, three METAR archives agree Polymarket’s resolver missed a report.',
      ],
    },
    {
      h: 'Who settles',
      p: [
        'A Chainlink CRE workflow reads two public archives (Iowa Environmental Mesonet and aviationweather.gov, with Ogimet as fallback), applies the rule, and reports the result on-chain with an operator attestation signature. Today it runs through the CRE simulation forwarder, which does not check who calls it — that is why the signature is mandatory.',
        challengeHours > 0
          ? `After a report there is a ${challengeHours}-hour challenge window in which the guardian can only turn the result into a void (never into a different temperature). Redemption opens when it ends.`
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
  const hours = caps ? Math.round((caps.challengeWindow / 3600) * 10) / 10 : 0;
  const sections = content(lang, hours);
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
