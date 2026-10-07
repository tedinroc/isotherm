import { useState } from 'react';
import { useI18n } from '../i18n';
import { useWallet } from '../wallet/wallet';
import { short } from '../lib/format';
import { IconX } from './icons';

export function WalletSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const w = useWallet();
  const [reveal, setReveal] = useState<string | null>(null);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={t('wallet.signin')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <h2>{w.address ? short(w.address) : t('wallet.signin')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('misc.close')}>
            <IconX />
          </button>
        </header>

        {!w.address && (
          <div className="stack">
            {/* With an environment id, Dynamic (email -> embedded wallet) is the default; the dev wallet is the
                labelled fallback. Without one, the dev wallet is the only option and the sheet says why. */}
            {w.dynamicAvailable && (
              <>
                <button
                  className="btn primary"
                  disabled={w.dynamicLoading}
                  data-testid="dynamic-login"
                  onClick={() => {
                    w.openDynamicLogin();
                    onClose();
                  }}
                >
                  {w.dynamicLoading ? t('misc.loading') : t('wallet.signinEmail')}
                </button>
                <p className="fine">{t('wallet.dynamicExplain')}</p>
              </>
            )}
            <button
              className={`btn ${w.dynamicAvailable ? '' : 'primary'}`}
              data-testid="dev-wallet"
              onClick={() => {
                w.useDevWallet();
                onClose();
              }}
            >
              {w.dynamicAvailable ? t('wallet.useDevInstead') : t('wallet.useDev')}
            </button>
            <div className="devnote">
              <b>{t('wallet.devLabel')}</b>
              <p>{t('wallet.devExplain')}</p>
              {!w.dynamicAvailable && <p className="fine">{t('wallet.dynamicOff')}</p>}
            </div>
          </div>
        )}

        {w.address && (
          <div className="stack">
            <p className={`wallet-kind ${w.kind}`}>{w.kind === 'dev' ? t('wallet.devLabel') : w.email ?? t('wallet.dynamicLabel')}</p>
            <p className="mono small break">{w.address}</p>
            {w.kind === 'dev' && (
              <>
                <p className="fine">{t('wallet.devExplain')}</p>
                {reveal ? (
                  <p className="mono small break warnbox">{reveal}</p>
                ) : (
                  <button
                    className="btn small"
                    onClick={() => {
                      if (window.confirm(t('wallet.exportConfirm'))) setReveal(w.exportDevKey());
                    }}
                  >
                    {t('wallet.export')}
                  </button>
                )}
                <button
                  className="btn small danger"
                  onClick={() => {
                    if (window.confirm(t('wallet.resetConfirm'))) {
                      w.forgetDevWallet();
                      onClose();
                    }
                  }}
                >
                  {t('wallet.reset')}
                </button>
              </>
            )}
            {w.kind === 'dynamic' && (
              <button
                className="btn small"
                onClick={async () => {
                  await w.logout();
                  onClose();
                }}
              >
                {t('wallet.logout')}
              </button>
            )}
            {w.kind === 'dev' && w.dynamicAvailable && (
              <button
                className="btn small"
                onClick={async () => {
                  await w.logout();
                  w.openDynamicLogin();
                  onClose();
                }}
              >
                {t('wallet.signinEmail')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
