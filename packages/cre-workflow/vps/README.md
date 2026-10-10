# Settlement on a small Linux VPS: kit and runbook

**Status (2026-10-10).** Live: the VPS has settled since the cutover at 2026-10-10 08:18 UTC (Ubuntu 26.04 LTS; the
kit was rehearsed on 24.04 and builds the byte-identical WASM `413d4429…` on 26.04). The Mac job is disabled and released.
One CRE session per account: signing in on the VPS ended the Mac's session, so a rollback needs a fresh `cre login` on the
Mac. The provider blocks NTP, so the VPS syncs time with `htpdate` over HTTPS. Rollback: section 7.

**Why.** Since the cutover on 2026-10-08, the market maker, the daily roll, the kill switch and the challenge watcher run on
the Cloudflare Worker (`docs/OPERATIONS.md` §8). The hourly CRE settlement job is the last thing that needs the Mac to
stay awake during judging (Oct 14 – Nov 3). A Worker cannot run the official CRE CLI, but a small Linux VPS can.

**What moves: one job, unchanged.** The VPS runs the same `scripts/settle-job.sh`, hourly at :05, under a systemd timer
instead of launchd.

| Kept exactly as today | Added on the VPS (`vps/settle-vps.sh` around the job) |
|---|---|
| **Official path:** `cre workflow simulate ./settle -T testnet --non-interactive --trigger-index 2 --broadcast`, with CLI v1.37.0 pinned by SHA-256 | A single-writer guard (section 8), so the Mac and the VPS never both settle |
| **Labelled harness fallback** when `cre whoami` fails, and one harness run after a failed official run | An optional phone push through ntfy, sent from the VPS's own IP |
| `run-official.sh`: the preflight, `var/run.lock`, the 30-min spacing guard, receipt confirmation, and the stand-down once the Resolver points at the DON | |
| One evidence record per run (`var/evidence/`), which now also names the host (`"host": "vps"`) | |

The challenge watcher stays on the Worker, which holds the guardian key. The VPS holds only the attester key, so the
key that can sign settlements and the key that can challenge them stay on different machines.

**Cost.** About $5–7 a month for the VPS. MON does not change: about 0.0204 MON per report from the attester, as on the
Mac. The guard's nonce reads are free.

## 1. Files

| File | Runs on | What it does |
|---|---|---|
| `setup.sh` | VPS | One-time, idempotent setup on Ubuntu 24.04 (amd64 or arm64). Refuses root. Installs the apt packages, then Foundry `cast` 1.8.5 (SHA-256-pinned, `cast` only). Calls `../setup.sh`: CRE CLI v1.37.0 and bun 1.4.2, both pinned, then `bun install --frozen-lockfile`. Runs a `cre workflow build` check that compares the WASM hash with the Mac's. Installs the systemd user units (not enabled) and turns on `loginctl enable-linger`. |
| `systemd/isotherm-settle.{service,timer}.in` | VPS | The service is oneshot, entry `settle-vps.sh`. The timer: `OnCalendar=*-*-* *:05:00 UTC`, `Persistent=true`, `AccuracySec=1s`. |
| `settle-vps.sh` | VPS | systemd entry. Runs the single-writer guard and the alerts around the unchanged `scripts/settle-job.sh`. |
| `isotherm-vps.sh` | VPS | Helper: `status`, `preflight`, `dry-run`, `login`, `test-alert`, `clear-conflict`, `logs`. `check`, `claim` and `release` are called by the Mac scripts over SSH. |
| `lib.sh`, `lib-mac.sh` | both | Shared helpers. They never print a key or the alert URL. |
| `push.sh` | Mac | Ships the job's code to `~/isotherm` on the VPS: `packages/cre-workflow` without `var/`, `.tools/`, `node_modules/`, keys or `.env`, plus `packages/abi` and `deployments/testnet.json`. Then it checks that the code on the VPS is byte-identical to the checkout. |
| `cutover.sh` | Mac | Mac → VPS. A dry run by default; `--execute` does the switch (section 6). |
| `rollback.sh` | Mac | VPS → Mac. A dry run by default; `--execute` does the switch back (section 7). |
| `test/` | Mac and test containers | The container rehearsal (section 10). Test only. |
| `evidence/` | | The outputs of that rehearsal. |

**Shared scripts changed for Linux.** They keep working on macOS, and both are tested in section 10.
- **Key-mode check.** `scripts/run-official.sh` checked it with BSD `stat -f %Lp`. On Linux that command prints
  file-system information instead of the mode, so every preflight on Linux failed with "key file must be chmod 600". It
  now runs `stat -c %a` first and falls back to the BSD form. `scripts/lib-don.sh` had the two forms in the wrong order,
  with the same effect.
- **Pinned Linux downloads.** `setup.sh` gained the pinned Linux CLI and bun downloads, and download retries.

**Shared scripts changed for the single-writer guard.**
- `run-official.sh` honours `var/writer.released`.
- `settle-job.sh` passes `--host` and `--job` to the evidence record.
- `settle/e2e/evidence-record.ts` records `host`, `job` and `stoodDownForWriter`.
- `scripts/don-rollback.sh` R5 no longer reloads the Mac job once the VPS is the writer.

## 2. Choose a VPS (the owner's purchase)

**Requirements.**
- Ubuntu 24.04 LTS, amd64 or arm64.
- 1 vCPU.
- **1 GB RAM plus a 1 GB swap file, or 2 GB.** Measured: the compile step peaks at about 700 MB RSS. Under a 1 GB cap
  it always succeeded; under 768 MB it passed once and failed once, so 768 MB is too tight; under 512 MB it fails
  (`evidence/memory.txt`). `simulate` compiles first and then runs the engine.
- 10 GB disk.
- A public IPv4 address. IPv6-only plans are untested with GitHub, the Monad RPC and ntfy.
- SSH key login.

No inbound port other than SSH is needed. The region does not matter for correctness; Tokyo or Singapore is closest to
the team.

Prices are from the providers' pages on 2026-10-09, monthly, before tax. Confirm them at checkout.

| Provider | Plan | vCPU / RAM / disk | Price | Asia regions | Notes |
|---|---|---|---|---|---|
| Vultr | Cloud Compute, Regular | 1 / 1 GB / 25 GB | **$5** | Tokyo, Osaka, Seoul, Singapore | Price from 2026 third-party listings; vultr.com refused automated reads. High Performance 1 GB is $6. Hourly billing. |
| Akamai (Linode) | Nanode 1 GB | 1 / 1 GB / 25 GB | **$5** | Tokyo, Osaka, Singapore, Jakarta | Official page, Jakarta selected; some regions are priced differently. |
| DigitalOcean | Basic Droplet | 1 / 1 GiB / 25 GiB | **$6** | Singapore, Bangalore | Official page. 2 GiB is $12. |
| AWS Lightsail | Linux bundle with IPv4 | 2 (burstable) / 1 GB / 40 GB | **$7** | Tokyo, Seoul, Singapore | Official page. The $5 IPv6-only bundle is not recommended. |
| Hetzner Cloud | CPX11, Singapore | 2 / 2 GB | about $13 + IPv4 | Singapore | Not recommended now: two price rises in 2026 (April, June). |
| Oracle Cloud | Always Free, Ampere A1 (arm64) | up to 4 / 24 GB | $0 | Tokyo, Osaka, Singapore, Seoul | A card is needed at sign-up. Idle Always Free instances can be reclaimed, which is a risk for a job that is idle 59 minutes an hour. Capacity is often unavailable. |

**Suggestion:** Vultr or Akamai, 1 GB, in Tokyo or Singapore. Through Nov 3 that is about $5–10 in total. Buying and owning
the account is the owner's step; nothing in this repository creates accounts.

## 3. Prepare the VPS (owner, about 20 minutes)

1. **Create the server** with Ubuntu 24.04 LTS and your Mac's SSH public key.
2. **Create a non-root user** if the image logs you in as root. The job and its keys belong to this user.
   ```bash
   ssh root@<ip>
   adduser isotherm && usermod -aG sudo isotherm        # sets the sudo password
   install -d -m 700 -o isotherm -g isotherm /home/isotherm/.ssh
   install -m 600 -o isotherm -g isotherm ~/.ssh/authorized_keys /home/isotherm/.ssh/authorized_keys
   ```
3. **Recommended hardening** (optional, your call; the VPS will hold the attester key):
   ```bash
   printf 'PasswordAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/00-isotherm.conf >/dev/null && sudo sshd -t && sudo systemctl reload ssh
   sudo sshd -T | grep -iE '^(passwordauthentication|permitrootlogin) '     # expect: no, no
   sudo ufw allow OpenSSH && sudo ufw enable
   sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
   The SSH settings go into a drop-in that sorts first, because sshd keeps the first value it reads: provider images
   often ship `sshd_config.d/50-cloud-init.conf` with `PasswordAuthentication yes`, which wins over an edit of
   `sshd_config` itself (checked in the test container). Ubuntu turns on unattended security upgrades by default.
4. **Add an SSH alias on the Mac** in `~/.ssh/config`. The scripts use key login only (BatchMode).
   ```
   Host isotherm-vps
     HostName <ip>
     User isotherm
   ```
5. **Ship the code and set up**, from the repository root on the Mac. It asks for the sudo password once and takes about
   2 minutes.
   ```bash
   packages/cre-workflow/vps/push.sh isotherm-vps --setup
   ```
   Expect `CRE CLI version v1.37.0`, `bun 1.4.2`, `cast Version: 1.8.5`, and
   `binary.wasm 413d4429…: byte-identical to the Mac build`. The CLI also prints "Update available ... 1.38.0". The pin
   to 1.37.0 is deliberate: the evidence and the DON plan were measured with it.

## 4. CRE login on the VPS (owner)

**Option A (the default): `cre login` through an SSH tunnel.** The CLI's browser sign-in returns to
`http://localhost:53682/callback`. The tunnel carries the Mac's port 53682 to the CLI on the VPS:
```bash
ssh -t -L 53682:127.0.0.1:53682 isotherm-vps bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh login
```
1. The CLI prints `Opening browser to: https://login.chain.link/authorize?...`, then `Could not open browser
   automatically`.
2. Copy that URL into the Mac's browser and sign in with your password and authenticator code. The browser goes back to
   `localhost:53682`, and the tunnel delivers it to the VPS.
3. The helper then prints `cre whoami: yes`. It shows only yes or no, never the account box.

While you do this, nothing else on the Mac may use port 53682 (for example, a `cre login` running on the Mac).

- **Verified in a container** (`evidence/login-tunnel.txt`): on headless Linux the CLI prints the URL and listens on
  `127.0.0.1:53682`. A request to the Mac's `localhost:53682/callback` reached the CLI's callback handler through
  `ssh -L`; the CLI rejected the deliberately empty request with "invalid state".
- **UNVERIFIED:** the sign-in itself, which needs the owner's account and authenticator, and how long the session lasts.
  The sign-in asks for `offline_access`, which means a refresh token; its expiry is undocumented, as on the Mac.
  `status`, the `harness fallback ran` push and the evidence record's `path` show when the session has lapsed. When it
  has, run the command above again.

**Do not copy `~/.cre` from the Mac.** The session carries a refresh token. Two machines refreshing one session could
invalidate each other; the CLI has a "Refresh token revoked" error. The Mac keeps its own session for the rollback.

**Option B (UNVERIFIED): a CRE API key.** The CLI says `login is not supported in non-interactive mode, use CRE_API_KEY
instead`. If the CRE web app gives your organization an API key:
1. Write it to `~/.config/isotherm/cre-api-key` on the VPS (chmod 600).
2. `settle-vps.sh` then exports it for the job only, and the official path is taken.

It was not tested whether `simulate --broadcast` accepts an API key the way it accepts a login session. If it does not,
the official run fails, the next run uses the harness, and you get a push.

## 5. Attester key, phone push, rehearsal (owner, no MON)

**Copy the attester key.** Never `cat` or `echo` it.
```bash
ssh isotherm-vps 'umask 077; mkdir -p ~/.config/isotherm'
scp ~/.config/isotherm/attester.key isotherm-vps:.config/isotherm/attester.key
ssh isotherm-vps 'chmod 600 ~/.config/isotherm/attester.key; bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh preflight'
```
- Expect `attester 0x63D2523dDC4BB055A19682Bf2d61fe94959D0Bb9 == Resolver.attester(); tx sender … has … MON` and
  `preflight OK`. These are chain reads only; nothing is signed.
- The key now lives on two machines. The Mac's copy stays there for the rollback. Rotate the key after judging
  (`DON-CUTOVER.md` §6, C6).

**Phone push (optional).** Use an ntfy topic with a long random name; it can be the same one the Worker uses.
The VPS push speaks **ntfy only** (a plain-text body with a `Title` header). If the Mac's `alert-webhook.url` is an
ntfy URL, copy it as below. If it is a Telegram bot URL (the maker Worker's free alternative to a paid ntfy plan,
`docs/OPERATIONS.md` §8.9), do not copy it: Telegram answers that request with HTTP 400 and the VPS's alerts would
only reach its log. Write an `https://ntfy.sh/<topic>` URL to the VPS's file instead (for example with `ssh -t
isotherm-vps 'umask 077; cat > ~/.config/isotherm/alert-webhook.url'`, paste, Ctrl-D).
```bash
ssh isotherm-vps 'umask 077; cat > ~/.config/isotherm/alert-webhook.url' < ~/.config/isotherm/alert-webhook.url
ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh test-alert   # expect "push: sent (HTTP 200)"
```
- The VPS posts from its own IP. The HTTP 429 that ntfy.sh returned to the Worker came from Cloudflare's shared egress
  IPs, so it does not apply here.
- The job sends at most a few pushes an hour. A push with the same title is repeated only after its dedupe window:
  3 h for a failure, 12 h for the harness fallback, 24 h for low MON, 6 h for a standing conflict.
- The URL is read from the file and never reaches a command line or a log.

**Rehearse on the VPS.**
```bash
ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh dry-run
ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh status
```
- `dry-run` is the whole job with `ISOTHERM_SETTLE_DRY=1`: the official `simulate` without `--broadcast` when logged in,
  otherwise the harness without sending.
- It uses its own state directory (`var/dry`), so it never uses up the real 30-minute slot.
- Expect `path=official` and `exit 0`.

## 6. Cutover: Mac → VPS (owner, about 10 minutes)

**When.** UTC minutes :16–:49, and not between 16:40 and 19:20 UTC. That window covers the first settlement attempts
(RJTT 17:05, RCSS 18:05), their challenge windows and the first retries. Good times are 01:00–15:00 UTC (09:00–23:00
Taipei).

**Run it from the repository root on the Mac.**
```bash
packages/cre-workflow/vps/push.sh isotherm-vps                 # the VPS gets exactly this checkout's code
packages/cre-workflow/vps/cutover.sh isotherm-vps              # dry run: every gate, READY or NOT READY
packages/cre-workflow/vps/cutover.sh isotherm-vps --execute
```

**Gates.** The dry run shows each one. `--execute` refuses unless all pass.
- The time window.
- The Mac holds the writer role. If its runtime copy already says it handed the role to a VPS, that must be this same
  VPS (a re-run, for example after "STOPPED SAFE"); for any other VPS, roll that one back first.
- The VPS answers over SSH.
- CLI v1.37.0, bun and cast are on the VPS.
- The VPS code is byte-identical to this checkout, for the 7 files of the job and the guard.
- The VPS preflight passes: the key file is mode 600, `attester == Resolver.attester()`, and the sender holds at least
  0.025 MON.
- The VPS is logged in to CRE. `--allow-harness` waives this; the VPS then settles through the labelled harness until
  you log in.
- The units are installed and linger is on.
- The VPS is not already the writer, and no conflict stands there.
- No settle job is running on the Mac.

**What `--execute` does.**

| Step | Where | Action |
|---|---|---|
| E1 | Mac | `launchctl bootout` and `launchctl disable` of `xyz.isotherm.cre-settle`, then a check that it is not loaded and is disabled. `disable` survives logins and reboots; `bootout` alone does not. |
| E2 | Mac | `scripts/deploy-runtime.sh` (sync only), so `~/isotherm-live` gets the writer check. Then it writes `~/isotherm-live/packages/cre-workflow/var/writer.released`, which names the VPS (the ssh destination as typed). From then on, the Mac copy refuses to sign even if someone starts the job by hand. A manual `run-official.sh` from the repository refuses too, because it shares that state directory. |
| E3 | VPS | `isotherm-vps.sh claim`, with the Mac's last run (`var/last-run` and `evidence/LATEST.json`, read again after E2) on stdin. It records the previous writer's last run, enables and starts `isotherm-settle.timer`, sets the tripwire's baseline to the sender's current nonce (what the Mac sent while it was the writer is not a conflict), and only then writes `var/writer.claim`. |

**If E3 fails.**
1. The script asks the VPS to release: timer off, no claim.
2. Only when the VPS confirms does it re-enable and reload the Mac job.
3. If the VPS cannot confirm, the Mac job stays off and the script says that neither host settles. Fix the connection,
   then run the cutover or the rollback again. The Worker's `SETTLEMENT OVERDUE` alert fires 3 h after day end.

**Check after the cutover.**
- `launchctl list | grep xyz.isotherm` prints nothing.
- `ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh status` shows the writer CLAIMED, the
  timer `enabled/active` and the next run at :05.
- The first signing run is at the first :05 that falls at least 50 minutes after the Mac's last run; `cutover.sh` prints
  the time. Earlier runs, including a `Persistent=true` catch-up, refuse with `peer-recent`.
- After that run, `isotherm-vps.sh logs` shows `[settle-job] path=official`,
  `[vps] tripwire: nonce N -> N, own txs 0: single writer`, and an evidence record with `"host": "vps"`.
- At the night's 18:05 UTC attempt:
  - a `report sent RCSS <date>` push;
  - on the Worker, `node scripts/control.mjs status` shows the watcher verdict `MATCH`;
  - no `SETTLEMENT OVERDUE` alert at 19:00 UTC.

## 7. Rollback: VPS → Mac (owner)

```bash
packages/cre-workflow/vps/rollback.sh isotherm-vps             # dry run: both sides' state and the plan
packages/cre-workflow/vps/rollback.sh isotherm-vps --execute
```

| Step | Where | Action |
|---|---|---|
| R1 | VPS, **first** | `isotherm-vps.sh release` disables and stops the timer and waits for a running job. It then removes the claim and writes `var/writer.released`, after which the VPS's `run-official.sh` refuses to sign. It returns the VPS's last run. If this fails, nothing changes on the Mac. |
| R2 | Mac | The runtime copy's `var/last-run` becomes the later of the Mac's and the VPS's last runs, so the Mac's own 30-minute guard covers the switch. Then `writer.released` is removed. |
| R3 | Mac | `launchctl enable` and `launchctl bootstrap` of `xyz.isotherm.cre-settle`. If the plist is missing, it is rendered from the runtime copy. The script then checks that the job is loaded. The next run is at :05: the official path with the Mac's own session, otherwise the harness. If this step fails, the script says that neither host settles and prints the two `launchctl` commands. |

Name the same VPS as at the cutover (`writer.released` on the Mac records it). A rollback that names another VPS is
refused, with or without `--vps-unreachable`: it would reload the Mac while the real writer may still hold the claim.

**If the VPS cannot be reached.** First power it off, or destroy it, at the provider. A VPS that is only unreachable may
still run its timer. Then run:
```bash
packages/cre-workflow/vps/rollback.sh isotherm-vps --execute --vps-unreachable
```
and type `THE VPS IS OFF`. The Mac's spacing guard then counts from that moment.

After a rollback the Mac must stay awake and logged in again (`docs/OPERATIONS.md` §3). To move back to the VPS later,
run `cutover.sh` again.

## 8. The single-writer safeguard

**The risk.** Two hosts with the same attester key each run at :05, and each signs and sends a report for the same
ladder. The Resolver is write-once and both apply the same rule, so only one report lands, with the same result. The
other report still bills about 0.0204 MON, can collide on the nonce, and leaves a "sent but not accepted" record. That
record makes the next run use the harness and triggers a false alarm. The goal is that this never happens, and that it
is caught at once if it does.

| Layer | Where | What it prevents or catches | Rehearsed in |
|---|---|---|---|
| 1. Claim | VPS | `settle-vps.sh` refuses without `var/writer.claim`. Only the cutover writes it, after the Mac job is verified unloaded and disabled. A timer enabled by mistake, or before the cutover, does nothing. | S0; C3, C4 |
| 2. Released marker | both | `run-official.sh` stops before reading a key when its state directory holds `writer.released` (exit 0, `SKIPPED`; the evidence shows `stoodDownForWriter`). This is the Mac after a cutover, including manual runs from the repository, and the VPS after a rollback. | S8; C5 |
| 3. Handover spacing | both | The VPS refuses while the previous writer ran less than **50 minutes** ago. That is longer than the 30-minute spacing guard and the 25-minute attestation lifetime, and shorter than the hourly cadence, so :05 → :05 works. It covers `Persistent=true` catch-up runs. The rollback hands the VPS's last run to the Mac's unchanged 30-minute guard. | S1, S2; C6, C8 |
| 4. On-chain tripwire | VPS | One free `eth_getTransactionCount` of the sender before and after each run, compared with what this host recorded after its last run (or at the claim) and with the transactions this run logged. An extra nonce means another holder of the key sent a transaction. The VPS then writes `var/writer-conflict`, sends a high-priority push, and stops signing until `isotherm-vps.sh clear-conflict`. It yields: the other writer keeps settling. | S4–S7; T1–T5; C10 |
| 5. Ordering | Mac scripts | The rollback releases the VPS before it re-enables the Mac. The cutover's undo re-enables the Mac only after the VPS confirms it holds no claim. A cutover to a second VPS, or a rollback naming another VPS, is refused while the Mac's `writer.released` names the first one. | C3, C5b, C8, C9 |

**Why not a lease.**
- *An on-chain lease* costs MON on every renewal, and MON is the bottleneck.
- *A Cloudflare KV lease* would put an API token on both hosts and add a new outage mode.

The nonce read is free, global, and needs no new secret.

**Limits.**
- Layer 4 sees another host only once that host sends a transaction. Runs that send nothing are harmless.
- If both hosts send at the same second with the same nonce, the chain keeps one transaction, so nothing lands twice.
  That is caught only when this VPS's transaction is the one dropped.
- A report whose delivery failed logs no hash (official: `writeReport <status>`; harness: `send-report failed`), yet
  its transaction may have used a nonce (mined and reverted, or a receipt that never came). Such a run allows one extra
  nonce per failed report and records no baseline, so the next run re-baselines. The price: another host's transaction
  in that run, or before the next run, can go unnoticed once (`T2`, `T3` in `tripwire-unit.txt`).
- If this host sends a transaction and logs neither its hash nor a failure, the guard sees a false conflict. This was
  not observed. Settlement then pauses until `clear-conflict`, and the Worker's `SETTLEMENT OVERDUE` alert (day end +
  3 h) is the backstop.

## 9. Operating it

| Goal | Command (on the Mac: `ssh isotherm-vps …`) |
|---|---|
| State at a glance | `bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh status` |
| Recent runs | `bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh logs 100`, or `journalctl --user -u isotherm-settle` |
| Next run | `systemctl --user list-timers isotherm-settle.timer` |
| Log in to CRE again | the tunnel command in section 4 |
| After a writer conflict, once one host settles | `bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh clear-conflict` |
| Ship a code change | `packages/cre-workflow/vps/push.sh isotherm-vps` from the Mac, between :10 and :02. Run `vps/setup.sh` again only if the toolchain or `settle/bun.lock` changed. |
| Pause settlement (nothing settles meanwhile) | `systemctl --user stop isotherm-settle.timer`; resume with `start` |

**Alerts**, each with its own dedupe window:
- `report sent <ICAO> <date>`, every time;
- `settle job exit N` (3 h);
- `harness fallback ran` (12 h);
- `attester low on MON` below 0.1 MON (24 h);
- `WRITER CONFLICT` (every time), then `still stopped` (6 h).

Every alert is also kept in `var/alerts/ALERTS.log`.

## 10. Tests run on 2026-10-09 (`evidence/`)

Run `vps/test/run-container-tests.sh all` on a Mac with Docker or OrbStack. It uses Ubuntu 24.04 containers: arm64
natively, and amd64 emulated. The stand-in VPS boots systemd as PID 1 and is reached over SSH like a real one. Nothing
live is sent. No real key, CRE session, launchd job or `~/isotherm-live` is used: the Mac side runs against a stub
`launchctl` and a scratch HOME.

| File | What it shows |
|---|---|
| `push.txt` | The first `push.sh` to a fresh VPS without rsync uses a tar stream. About 1 MB arrives, and no key, `.env`, `var/`, `.tools/`, `node_modules/` or `*.wasm`. The code checks as byte-identical. |
| `setup-arm64.txt`, `setup-amd64.txt` | `setup.sh` passes on both architectures. CLI v1.37.0, bun 1.4.2 (amd64: the baseline build was chosen automatically, as the emulated CPU reports no AVX2) and cast 1.8.5 are installed. **`cre workflow build` produces `413d4429…`, byte-identical to the Mac's WASM, on both.** The units are installed, linger is on, and a second push uses rsync. |
| `lint.txt` | shellcheck is clean on every new script, apart from two intentional patterns in the test scripts, which are disabled with a comment. The changed shared scripts carry only the findings they had at HEAD. `systemd-analyze verify` passes; the schedule is :05 UTC. |
| `systemd-fork-e2e.txt` | **18 checks** run through the installed systemd unit against an anvil fork of live testnet. The fork reads come from the Ankr RPC, the attester is set on the fork, and the tx key is a fresh random one. Covered: no claim; the 50-minute guard; a harness settlement of RCSS 2026-10-09 with evidence `host: vps` and pushes; the spacing guard; a conflict between runs and during a run, sticky and deduplicated; `clear-conflict`; `release`, after which a preflight still runs in full; a dry run; the timer starting the service. |
| `tripwire-unit.txt` | **7 checks** of the tripwire against the log lines of the OFFICIAL path, which the fork run cannot reach without a CRE login: the real `settle-vps.sh` with a stub job that prints official-path lines and sends real transactions on a local anvil chain. Covered: a logged report; a failed `writeReport` whose transaction used a nonce (no conflict, the next run re-baselines); the same plus another host's transaction (conflict); an unlogged transaction (conflict); a claim after the other host sent in between (no conflict). |
| `mac-cutover-rehearsal.txt` | **14 checks** of `cutover.sh` and `rollback.sh` from the Mac against the stand-in VPS. Covered: NOT READY versus READY; the E3 failure undone safely; the full cutover with a real preflight gate; a manual Mac run refused; a cutover to another VPS and a rollback naming another VPS refused (C5b); the VPS's 50-minute guard and then its settlement; the full rollback with `last-run` handed back; the unreachable-VPS refusals and the confirmed path; a second cutover after the rollback, whose first VPS run finds no conflict (C10). |
| `live-readonly.txt` | Live reads only. The handler's dry run on live chain reads and METAR sources. The job's dry run with a throwaway key, which stops at "attester … != Resolver.attester()". The mode-check fix on Linux, with the old form's output shown. |
| `login-tunnel.txt` | Section 4, Option A, up to the sign-in. |
| `memory.txt` | The compile step under 1 GB (passes, about 700 MB peak), 768 MB (failed in this run; it passed in an earlier one) and 512 MB (fails) caps, with no swap. |
| `mac-preflight.txt` | The macOS branch of the mode check is unchanged: a 600 key passes, a 644 key is refused. |

Also run on the Mac: `bun test` (93 pass, 11 fork suites skipped) and `bun run typecheck`. `setup.sh` reports no changes
on the Mac.

**Fixed because the rehearsal caught them.**
- macOS `/bin/bash` 3.2 cannot parse `case … in pattern)` inside `$( … )`, which made two cutover gates fail.
- A host holding `writer.released` answered `--preflight-only` with "SKIPPED", so the cutover's preflight gate passed
  without a preflight. `--preflight-only` and dry runs now run in full on such a host.
- A transient `curl (18)` interrupted a release download; every download now retries, and setup fails closed.
- The first full run also showed the code-identity gate at work: it refused a VPS whose copy of two files was older than
  the checkout.

**Fixed after an independent review (2026-10-09), each with a check that failed before the fix.**
- A second cutover after a rollback stopped the VPS at its first run with a false `WRITER CONFLICT`: the tripwire still
  held the nonce from before the rollback, so the Mac's reports in between looked like another writer. `claim` now
  re-baselines the tripwire (C10, T5).
- On the official path a failed `writeReport` logs no hash. If its transaction was mined (reverted) or its receipt never
  came, the nonce moved with nothing to explain it, and the VPS stopped with a false `WRITER CONFLICT` exactly when the
  next run was needed to retry. Such a run now allows that nonce and re-baselines next time (T2).
- Nothing stopped a cutover to a second VPS while the first still held the claim, or a rollback (including
  `--vps-unreachable`) that named the wrong VPS. `writer.released` now records the destination, and both are refused
  (C5b).
- `release` waited for a running job with `systemctl is-active`, which answers non-zero for a running oneshot unit
  ("activating"), so it never waited for the unit itself. It now reads `ActiveState`.
- `rollback.sh` R3 exited without a message if `launchctl` failed after R2; it now says that neither host settles and
  what to run.

**Found while testing.** The public anvil dev accounts #1 and #9 carry EIP-7702 delegations on live Monad testnet: their
code is `0xef0100` followed by a delegate address. On a fork, a 0-value transfer from #1 to itself ran the delegate
(37,988 gas) and emptied the account. The VPS tests therefore use a fresh random tx key. The existing Mac fork scripts use
those accounts only to sign or to send reports to the forwarder, which never calls the delegate.

## 11. With the Chainlink DON (`DON-CUTOVER.md`)

- **The VPS job stands down by itself** while `Resolver.forwarder()` is not the MockKeystoneForwarder, because it runs
  the same `run-official.sh`. Leave its timer on through the DON switch.
- **Gate 6** ("the Mac job is not loaded") passes after the VPS cutover.
- **Gate 7** checks the Mac's runtime copy, which `cutover.sh` synced.
- **`don-rollback.sh` R5** no longer reloads the Mac job when the Mac holds `writer.released`; that would make two
  writers. The VPS's next :05 run settles through the mock.
- **Keep `deployments/testnet.json` on the VPS at `activeForwarder` = mock**, because the harness fallback delivers to
  that address. Do not push to the VPS while the DON is active, or push again after a DON rollback.

## 12. Limits and open points

- **Not done, by design:** no VPS bought, nothing deployed, no key copied, no live transaction, no launchd change.
- **The official path has not run end to end on Linux**, because it needs the CRE login. Its compile step has, with
  byte-identical WASM on arm64 and amd64. The harness path ran end to end under systemd on a fork.
- **The real `cre login` on a VPS and Option B (the API key) are UNVERIFIED** (section 4).
- **RPC.** `project.yaml` and `run-official.sh` pin the official RPC `https://testnet-rpc.monad.xyz` for the official
  path, unchanged. It limits each client IP to 15 requests a second. The VPS has its own IP and a run makes about 30
  sequential reads, so this is fine. If a provider puts several customers behind one IP and the limit bites, switching
  the RPC is a separate change to the official path.
- **The attester key on a VPS.** The hardening in section 3 is recommended. The guardian's challenge watcher on the
  Worker is the backstop for a wrong report.
