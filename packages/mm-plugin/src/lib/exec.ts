// Every write goes through ctx.walletExecutor (MetaMask policy + signing). This module adds what Monad needs:
//   - Monad bills the GAS LIMIT, so we estimate first and send limit = ceil(estimate x multiplier)
//   - a step that would revert is caught at estimate time and explained (decoded custom error), before signing
//   - multi-step flows (approve -> trade) wait for each receipt and report every step, even on failure
import { CommandError, type CommandIO } from "@metamask/agent-wallet/plugin";
import type { Abi, Address, Hex, TransactionReceipt } from "viem";
import { CHAIN_ID, EXPLORER } from "./config.js";
import { explainRevert, type Reader } from "./chain.js";
import { fmtUnits, shortErr, sleep } from "./util.js";

// Shape accepted by the mm 7.x executor (read from the built-in wallet:send-transaction).
export type ExecRequest = {
  kind: "transaction";
  chainId: number;
  transaction: { to: Address; data?: Hex; value?: bigint; gas?: bigint };
  intent?: { action: string; summary: string };
};
export type ExecResult = {
  kind?: string;
  hash?: string;
  status: string;
  failureCode?: string;
  failureDescription?: string;
  pendingJob?: { pollingId?: string };
};
export type Executor = (req: ExecRequest, opts?: { signal?: AbortSignal; noAwait?: boolean; waitForReceipt?: boolean }) => Promise<ExecResult>;

export type Step = { label: string; to: Address; data: Hex; value?: bigint; gasMult?: number };
export type StepResult = {
  label: string;
  to: Address;
  status: string;
  hash: string | null;
  explorerUrl: string | null;
  gasEstimate: string;
  gasLimit: string;
  gasUsed: string | null;
  maxMonBilled: string; // gasLimit x gas price at submit time (Monad bills the limit)
  pollingId?: string;
  failure?: string;
  reportedStatus?: string; // what the signing service reported when we confirmed the receipt ourselves
};

export type RunnerOpts = { gasMult: number; errorAbis: Abi[]; source: string };

export class TxRunner {
  readonly steps: StepResult[] = [];
  private exec?: Executor;
  private gasPrice?: bigint;
  constructor(
    private readonly getExecutor: () => Promise<Executor>,
    private readonly reader: Reader,
    readonly from: Address,
    private readonly io: CommandIO,
    private readonly opts: RunnerOpts,
  ) {}

  /** eth_estimateGas from the wallet; a revert becomes a CommandError that names the decoded reason. */
  async estimate(step: Step): Promise<bigint> {
    try {
      return await this.reader.client.estimateGas({ account: this.from, to: step.to, data: step.data, value: step.value ?? 0n });
    } catch (e) {
      const why = explainRevert(e, this.opts.errorAbis);
      throw new CommandError(
        "ISOTHERM_WOULD_REVERT",
        `'${step.label}' would revert: ${why}.${this.doneSoFar()}`,
        "Nothing was signed for this step. Re-run the read command (quote/positions) to refresh the book and balances, or adjust the amount/price.",
      );
    }
  }

  async send(step: Step): Promise<{ result: StepResult; receipt: TransactionReceipt | null }> {
    const est = await this.estimate(step);
    const mult = step.gasMult ?? this.opts.gasMult;
    const gas = BigInt(Math.ceil(Number(est) * mult));
    if (this.gasPrice === undefined) {
      try {
        this.gasPrice = await this.reader.client.getGasPrice();
      } catch {
        this.gasPrice = 102_000_000_000n;
      }
    }
    if (!this.exec) {
      try {
        this.exec = await this.getExecutor();
      } catch (e) {
        throw mapExecutorError(e, step.label, this.doneSoFar());
      }
    }
    let res: ExecResult;
    try {
      res = await this.exec(
        {
          kind: "transaction",
          chainId: CHAIN_ID,
          transaction: { to: step.to, data: step.data, value: step.value ?? 0n, gas },
          intent: { action: "custom", summary: step.label },
        },
        { signal: this.io.signal, waitForReceipt: true },
      );
    } catch (e) {
      throw mapExecutorError(e, step.label, this.doneSoFar());
    }
    const hash = res.hash || null;
    const r: StepResult = {
      label: step.label,
      to: step.to,
      status: res.status,
      hash,
      explorerUrl: hash ? `${EXPLORER}/tx/${hash}` : null,
      gasEstimate: est.toString(),
      gasLimit: gas.toString(),
      gasUsed: null,
      maxMonBilled: fmtUnits(gas * this.gasPrice, 18),
      ...(res.pendingJob?.pollingId ? { pollingId: res.pendingJob.pollingId } : {}),
      ...(res.failureDescription || res.failureCode ? { failure: [res.failureCode, res.failureDescription].filter(Boolean).join(": ") } : {}),
    };
    this.steps.push(r);
    // The signing service can hand back a tx hash before the tx is mined (status BROADCASTED/SUBMITTED). That is
    // not a failure: wait for the receipt on chain ourselves and only then decide (mined OK -> CONFIRMED).
    const reported = String(res.status ?? "").toUpperCase();
    const pendingWithHash = !!hash && PENDING_WITH_HASH.has(reported);
    if (res.status !== "CONFIRMED" && !pendingWithHash) throw statusError(r, this.doneSoFar(1));
    let receipt: TransactionReceipt | null = null;
    if (hash) {
      receipt = await this.receipt(hash as Hex, pendingWithHash ? 180 : 20);
      if (!receipt && pendingWithHash) {
        throw new CommandError(
          "ISOTHERM_TX_PENDING",
          `'${step.label}' was broadcast by MetaMask (${hash}) but no receipt arrived within 90 s.${this.doneSoFar(1)}`,
          "Check the explorer link, then re-run this command; steps already confirmed are skipped automatically.",
        );
      }
      if (receipt) {
        r.gasUsed = receipt.gasUsed.toString();
        if (receipt.status === "success" && pendingWithHash) {
          r.status = "CONFIRMED";
          r.reportedStatus = reported;
        }
        if (receipt.status !== "success") {
          r.status = "REVERTED";
          throw new CommandError("ISOTHERM_TX_REVERTED", `'${step.label}' was mined but reverted (${hash}).${this.doneSoFar(1)}`, "Check the explorer link; balances were not changed by the reverted step.");
        }
      }
    }
    this.io.log("info", `${step.label}: ${r.status} ${hash ?? ""}`);
    return { result: r, receipt };
  }

  private async receipt(hash: Hex, tries = 20): Promise<TransactionReceipt | null> {
    for (let i = 0; i < tries; i++) {
      try {
        return await this.reader.client.getTransactionReceipt({ hash });
      } catch {
        await sleep(500);
      }
    }
    return null;
  }

  private doneSoFar(skipLast = 0): string {
    const done = this.steps.slice(0, this.steps.length - skipLast).filter((s) => s.status === "CONFIRMED");
    return done.length ? ` Already confirmed earlier in this command: ${done.map((s) => `${s.label} (${s.hash})`).join("; ")}.` : "";
  }
}

const PENDING_WITH_HASH = new Set(["BROADCASTED", "SUBMITTED", "SIGNED", "PENDING"]);

function statusError(r: StepResult, done: string): CommandError {
  switch (r.status) {
    case "AWAITING_MFA":
      return new CommandError(
        "ISOTHERM_AWAITING_APPROVAL",
        `'${r.label}' is waiting for your approval in MetaMask (Guard Mode).${done}`,
        `Approve it from the MetaMask email/app${r.pollingId ? ` (or watch: mm wallet requests watch ${r.pollingId})` : ""}, then re-run this command; steps already confirmed are skipped automatically.`,
      );
    case "DENIED":
    case "REJECTED":
      return new CommandError(
        "ISOTHERM_TX_DENIED",
        `MetaMask policy denied '${r.label}'${r.failure ? `: ${r.failure}` : ""}.${done}`,
        "If you use a Guard Mode allowlist, add the Isotherm Zap, the CollateralVault, AUSD and the Kuru market (see `mm weather doctor`).",
      );
    default:
      return new CommandError(
        "ISOTHERM_TX_FAILED",
        `'${r.label}' ended with status ${r.status}${r.failure ? `: ${r.failure}` : ""}${r.hash ? ` (${r.hash})` : ""}.${done}`,
        "Run `mm weather positions` to see the current state before retrying.",
      );
  }
}

export function mapExecutorError(e: unknown, label: string, done: string): CommandError {
  if (e instanceof CommandError) return e;
  const msg = shortErr(e);
  const anyE = e as { terminalStatus?: unknown; status?: unknown; code?: unknown; failureCode?: unknown; data?: unknown; cause?: { data?: unknown } };
  const data = JSON.stringify(anyE?.data ?? anyE?.cause?.data ?? "");
  // mm 7.0.0 throws TRANSACTION_REQUEST_FAILED with `terminalStatus` when the signing service ends a request
  // (DENIED / EXPIRED / FAILED / BROADCAST_FAILED) instead of returning that status.
  const st = String(anyE?.terminalStatus ?? (typeof anyE?.status === "string" ? anyE.status : "")).toUpperCase();
  const hostCode = String(anyE?.code ?? "");
  const fc = anyE?.failureCode ? ` [${String(anyE.failureCode)}]` : "";
  if (st === "DENIED" || hostCode === "TX_DENIED") {
    return new CommandError(
      "ISOTHERM_TX_DENIED",
      `MetaMask policy denied '${label}': ${msg}${fc}.${done}`,
      "Nothing was broadcast for this step. If your wallet uses a Guard Mode / policy allowlist, allow the targets listed by `mm weather doctor` (Zap, CollateralVault, AUSD, Kuru MarginAccount and the market), then retry.",
    );
  }
  if (st.includes("EXPIRED") || hostCode === "TX_EXPIRED") {
    return new CommandError("ISOTHERM_APPROVAL_EXPIRED", `The approval window for '${label}' expired: ${msg}.${done}`, "Re-run the command and approve it in MetaMask before the window closes.");
  }
  if (st === "FAILED" || st === "BROADCAST_FAILED" || hostCode === "TX_FAILED" || hostCode === "TX_REVERTED") {
    return new CommandError("ISOTHERM_TX_FAILED", `'${label}' failed in the signing service (${st || hostCode}): ${msg}${fc}.${done}`, "Run `mm weather positions` to see the current state before retrying.");
  }
  if (/invalid chainid|status code: '400'|non-200 status code/i.test(msg + data)) {
    return new CommandError(
      "ISOTHERM_CHAIN_NOT_CONFIGURED",
      `mm could not reach Monad testnet (10143) for '${label}': ${msg}.${done}`,
      "MetaMask's hosted RPC gateway rejects 10143. Add the chain once with the bundled script: `curl -fsSL https://unpkg.com/mm-plugin-isotherm/scripts/setup-mm-monad.sh | SKIP_INSTALL=1 sh` (writes customEvmChains[10143]); `mm weather doctor` checks it.",
    );
  }
  if (/refresh token|mm login|AUTH|unauthor/i.test(msg)) {
    return new CommandError("ISOTHERM_NOT_SIGNED_IN", `Signing '${label}' needs an mm session: ${msg}.${done}`, "Run `mm login` and `mm init`, then retry.");
  }
  return new CommandError("ISOTHERM_EXECUTOR_ERROR", `mm executor failed on '${label}': ${msg}.${done}`, "Run `mm weather doctor` to check the chain setup, then retry.");
}
