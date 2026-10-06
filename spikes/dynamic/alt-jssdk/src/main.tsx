// Same Isotherm flow on Dynamic's CURRENT headless JS SDK (@dynamic-labs-sdk/*), for a
// bundle-size / API comparison with the legacy React SDK build in ../src. Headless: we own
// every screen (email OTP, Google redirect, wallet creation, delegation prompt).
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createDynamicClient } from '@dynamic-labs-sdk/client';
import {
  completeSocialRedirect,
  detectSocialRedirectUrl,
  signInWithSocialRedirect,
} from '@dynamic-labs-sdk/client';
import {
  createWaasWalletAccounts,
  delegateWaasKeyShares,
  getChainsMissingWaasWalletAccounts,
} from '@dynamic-labs-sdk/client/waas';
import { addWaasEvmExtension } from '@dynamic-labs-sdk/evm/waas';
import { isEvmWalletAccount } from '@dynamic-labs-sdk/evm';
import { createWalletClientForWalletAccount } from '@dynamic-labs-sdk/evm/viem';
import {
  DynamicProvider,
  useGetWalletAccounts,
  useInitStatus,
  useLogout,
  useOnEvent,
  useSendEmailOTP,
  useUser,
  useVerifyOTP,
} from '@dynamic-labs-sdk/react-hooks';
import { parseUnits, type Address } from 'viem';
import { authorizationTypedData, newAuthorization, toWire } from '../../src/lib/ausd';
import { relayer } from '../../src/lib/relayerClient';

const ENV_ID = import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID ?? '';
const RELAYER = import.meta.env.VITE_RELAYER_URL ?? 'http://localhost:8790';
const CHAIN_ID = 10143;

export const dynamicClient = createDynamicClient({
  environmentId: ENV_ID,
  metadata: { name: 'Isotherm', universalLink: window.location.origin },
  // Monad Testnet must be enabled in the dashboard; make it the default EVM network.
  transformers: {
    networksData: (list) =>
      [...list].sort((a, b) => Number(b.networkId === String(CHAIN_ID)) - Number(a.networkId === String(CHAIN_ID))),
  },
});
addWaasEvmExtension(); // embedded-only EVM extension (smaller than addEvmExtension)

function WaasBootstrap() {
  useOnEvent({
    event: 'userChanged',
    listener: async ({ user }) => {
      if (!user) return;
      const missing = getChainsMissingWaasWalletAccounts();
      if (missing.length) await createWaasWalletAccounts({ chains: missing });
    },
  });
  return null;
}

function App() {
  const { data: init } = useInitStatus();
  const { data: user } = useUser();
  const { data: accounts = [] } = useGetWalletAccounts();
  const { mutate: sendOtp, data: otp } = useSendEmailOTP();
  const { mutate: verify } = useVerifyOTP();
  const { mutate: logout } = useLogout();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const evm = accounts.find(isEvmWalletAccount);

  useEffect(() => {
    const url = new URL(window.location.href);
    void detectSocialRedirectUrl({ url }).then(async (is) => { if (is) await completeSocialRedirect({ url }); });
  }, []);

  if (init !== 'finished') return <p>Loading Dynamic… ({init})</p>;
  if (!user)
    return (
      <main>
        <button onClick={() => signInWithSocialRedirect({ provider: 'google', redirectUrl: window.location.href })}>
          Continue with Google
        </button>
        {!otp ? (
          <>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
            <button onClick={() => sendOtp({ email })}>Send code</button>
          </>
        ) : (
          <>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            <button onClick={() => verify({ otpVerification: otp, verificationToken: code })}>Verify</button>
          </>
        )}
      </main>
    );

  const gasless = async () => {
    if (!evm) return;
    const wc = await createWalletClientForWalletAccount({ walletAccount: evm });
    const from = evm.address as Address;
    const info = await relayer(RELAYER).info();
    const auth = newAuthorization({ from, to: info.depositTo, value: parseUnits('5', 6) });
    const sig = await wc.signTypedData({ account: wc.account, ...authorizationTypedData('transfer', CHAIN_ID, auth) });
    const r = await relayer(RELAYER).relay(toWire('transfer', CHAIN_ID, auth, sig));
    setLog((l) => [`relayed ${r.txHash}`, ...l]);
  };

  return (
    <main>
      <p>{user.email} · {evm?.address ?? 'creating wallet…'}</p>
      <button disabled={!evm} onClick={gasless}>Deposit 5 AUSD (gasless)</button>
      <button disabled={!evm} onClick={() => evm && delegateWaasKeyShares({ walletAccount: evm })}>
        Allow auto-roll (delegated access, Sandbox)
      </button>
      <button onClick={() => logout()}>Log out</button>
      <pre>{log.join('\n')}</pre>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <DynamicProvider client={dynamicClient}>
        <WaasBootstrap />
        <App />
      </DynamicProvider>
    </QueryClientProvider>
  </StrictMode>,
);
