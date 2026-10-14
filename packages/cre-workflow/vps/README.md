# Settlement on a small Linux VPS: kit and runbook

**Status (2026-10-10).** Live: the VPS has settled since the cutover at 2026-10-10 08:18 UTC (Ubuntu 26.04 LTS; the
kit was rehearsed on 24.04 and builds the byte-identical WASM `413d4429…` on 26.04). The Mac job is disabled and released.
When the VPS signed in to CRE, the Mac's session ended (seen once, at the cutover; whether an account can hold only one
session is unverified), so plan a fresh `cre login` on the Mac for a rollback. The provider blocks NTP, so the VPS syncs
time with `htpdate` over HTTPS. Rollback: section 7.

**Changes of 2026-10-14, in the repository but not yet on the VPS:** `settle-job.sh` checks a failed `cre whoami` once
more before it takes the harness, the `harness fallback ran` push says whether to act (section 4), and the stack
watchdog also reads the web app's RPC and the guardian and attester balances (section 13). They reach the VPS with the
next `push.sh` (section 9), which ships the whole working tree in one go; the owner approves it, outside 17:50–18:30
UTC.

**Why.** Since the cutover on 2026-10-08, the market maker, the daily roll, the kill switch and the challenge watcher run on
the Cloudflare Worker (`docs/OPERATIONS.md` §8). The hourly CRE settlement job is the last thing that needs the Mac to
stay awake during judging (Oct 14 – Nov 3). A Worker cannot run the official CRE CLI, but a small Linux VPS can.

**What moves: one job, unchanged.** The VPS runs the same `scripts/settle-job.sh`, hourly at :05, under a systemd timer
instead of launchd.

| Kept exactly as today | Added on the VPS (`vps/settle-vps.sh` around the job) |
|---|---|
| **Official path:** `cre workflow simulate ./settle -T testnet --non-interactive --trigger-index 2 --broadcast`, with CLI v1.37.0 pinned by SHA-256 | A single-writer guard (section 8), so the Mac and the VPS never both settle |
| **Labelled harness fallback** when `cre whoami` fails, and one harness run after a failed official run. Since 2026-10-10 an official run that stops at the CLI's CRE credential check, before anything is compiled or sent, is first repeated once, 45 s later; since 2026-10-11 `run-official.sh` checks a failed `cre whoami` once more, 30 s later, before it reports no login; since 2026-10-14 `settle-job.sh` also checks a failed `cre whoami` once more, 30 s later, before it takes the harness. | An optional phone push through ntfy, sent from the VPS's own IP |
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
| `stack-watch.sh`, `stack-watch.mjs` | VPS | The read-only stack watchdog for the judging period, every 10 min (section 13). |
| `install-watch.sh`, `systemd/isotherm-watch.{service,timer}.in` | VPS | Installs or removes the watchdog's two units; touches nothing of the settlement job (section 13). |
| `relogin.sh` | Mac | After a `CRE LOGIN NEEDED` push: the tunnel, the VPS's `login` helper and the browser sign-in in one command (section 4). |
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
  `status`, the `CRE LOGIN NEEDED` push and the evidence record's `path` show when the session has lapsed. When it
  has, see "CRE login lapsed" below.

**Do not copy `~/.cre` from the Mac.** The session carries a refresh token. Two machines refreshing one session could
invalidate each other; the CLI has a "Refresh token revoked" error. The Mac keeps its own session for the rollback.

**Option B (UNVERIFIED): a CRE API key.** The CLI says `login is not supported in non-interactive mode, use CRE_API_KEY
instead`. If the CRE web app gives your organization an API key:
1. Write it to `~/.config/isotherm/cre-api-key` on the VPS (chmod 600).
2. `settle-vps.sh` then exports it for the job only, and the official path is taken.

It was not tested whether `simulate --broadcast` accepts an API key the way it accepts a login session. If it does not,
the official run fails, the next run uses the harness, and you get a push.

### CRE login lapsed

The session's lifetime is undocumented, and whether an account can hold more than one session is unverified (when the
VPS signed in at the cutover, the Mac's session ended). When the VPS's session lapses, settlement does not stop: the job
takes the labelled harness fallback. You see it two ways:
- **Push `CRE LOGIN NEEDED`** (high priority, repeated every 3 h while it lasts). It fires when two runs in a row took
  the harness because `cre whoami` failed, or because `run-official.sh` found no login just before signing. One such
  run alone pushes nothing: `cre whoami` asks the CRE API, which now and then fails for a moment. In the Mac's 74 runs,
  3 single misses had an official run an hour before and an hour after. The VPS's records hold 3 more, each with
  official runs on both sides: 2026-10-11 01:05 UTC (`run-official.sh` found no login just before signing) and
  2026-10-13 05:05 and 23:05 UTC (a quick `cre whoami` failure). A harness run after a failed official run is not a
  miss, and a run whose `cre whoami` answered clears one.
- **The login check is repeated before the harness** (`scripts/settle-job.sh`, since 2026-10-14). In auto mode on the
  live RPC without `CRE_API_KEY`, a failed `cre whoami` is run once more 30 s later, before anything is locked, read or
  signed; only a second failure takes the harness, and the evidence record's reason then reads `cre whoami failed
  twice, 30 s apart (no CRE login, or the CRE API did not answer)`. In both VPS misses of 2026-10-13, the records show
  `run-official.sh`'s own `cre whoami` answering about a second after the job's had failed, so the re-check would most
  likely have kept both runs on the official path. Each check is bounded at 45 s, so the path choice waits about 120 s
  at most.
- **The `harness fallback ran` push** (12 h dedupe, same title) now says whether to act:
  - the first miss: "One miss alone can be a brief CRE API outage: act only on CRE LOGIN NEEDED, which is pushed if the
    next run finds no login either.";
  - a second or later miss in a row, when the dedupe lets it through: "N runs in a row without the CRE login: see CRE
    LOGIN NEEDED. The fix, on the Mac: packages/cre-workflow/vps/relogin.sh isotherm-vps";
  - after a failed official run: "Not a login problem: no relogin needed.";
  - if `lib.sh`'s `CRE_LAPSE_JS` cannot classify the run: "Cause not classified …", with the same fix.

  If step 5's alert script itself fails on a run that exited non-zero, `settle job exit N` is still pushed ("the
  alerts could not read this run's evidence record").
- **`isotherm-vps.sh status`** shows `cre session LAPSED since …` after two misses in a row, `no login in the last
  run …` after one (a single miss can be a brief CRE API outage), and otherwise `cre session valid for at least …` (the
  official runs since the last miss). When the misses since then were all single ones between runs that showed the
  login, it adds a second, labelled bound counted across them. It reads the evidence records only, never `~/.cre`.

The fix is one command on the Mac (`--dry-run` checks the prerequisites only):
```bash
packages/cre-workflow/vps/relogin.sh isotherm-vps
```
- It refuses if anything on the Mac listens on port 53682. It runs the tunnel and `isotherm-vps.sh login`, opens the
  sign-in page in your default browser and waits for `cre whoami: yes` (exit 0; exit 124 after `--timeout`, default
  600 s).
- You still sign in by hand, with your password and authenticator code. The CLI has no non-interactive login, so this
  step cannot be automatic (Option B is unverified).
- It never prints a token, and every exit removes its temp file and stops the ssh process, which ends the waiting
  `cre login` on the VPS.
- The next :05 run takes the official path and pushes `CRE LOGIN RESTORED` once. Assume that signing in on the VPS can
  end another session of the account, such as the Mac's: it did once, at the cutover (unverified beyond that).

Tests, no container needed: `test/login-lapse-unit.sh` (83 checks with stubs, including single misses, a failed
official run, lost state, Ctrl-C, the push advice by miss count and a broken `CRE_LAPSE_JS`; 82 on Linux, where R13
needs `lsof`: `evidence/login-lapse-unit-linux.txt`), `scripts/official-retry-check.sh` (121 checks of the two `cre
whoami` checks and `run-official.sh`'s retries, the same on Linux: `../evidence/official-retry-check-linux.txt`) and
`test/relogin-local-sshd.sh` (9 checks with the real ssh client, a throwaway sshd on 127.0.0.1 and a fake `cre`). Each
writes its report to a new file under `$TMPDIR` and prints the path; `ISOTHERM_WRITE_EVIDENCE=1` also writes the
tracked file in `evidence/` (or the file named by `ISOTHERM_TEST_EVIDENCE`), and only after a pass.

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
  3 h for a failure, 12 h for the harness fallback, 24 h for low MON, 6 h for a standing conflict, 3 h for
  `CRE LOGIN NEEDED`.
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
| 4. On-chain tripwire | VPS | One free `eth_getTransactionCount` of the sender before and after each run, compared with what this host recorded after its last run (or at the claim) and with the transactions this run logged. An extra nonce means another holder of the key sent a transaction. The VPS then writes `var/writer-conflict`, sends a high-priority push, and stops signing until `isotherm-vps.sh clear-conflict`. It yields: the other writer keeps settling. | S4–S7; T1–T8; C10 |
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
- This run's own transactions come from two places in the job's log (`scripts/sent-hashes.mjs`): the `tx 0x… ->` /
  `tx 0x… status=` lines, and the hash of each delivered report in the official path's result JSON. The second source
  exists because of a live false conflict. On 2026-10-11 at 18:05 UTC the simulator stopped (`context canceled`) before
  the workflow's last log line, `RCSS 2026-10-11: tx 0x0266fd… -> resolved`, reached its output. The report had landed
  and was accepted (checked by hand afterwards: `ReportProcessed.result=true`, Settled at 30 °C, the same as
  Polymarket). The guard counted 0 own transactions, raised `WRITER CONFLICT`, and refused every run until
  `clear-conflict` at 13:57 UTC the next day. No settlement was due in that window, so none was missed. The same
  dropped line had also skipped `run-official.sh`'s receipt check, which reads the same two sources now (T6–T8 in
  `tripwire-unit.txt`; D1–D3 in `evidence/official-retry-check.txt`).
- A transaction that neither source shows still gives a false conflict. Settlement then pauses until `clear-conflict`,
  and the Worker's `SETTLEMENT OVERDUE` alert (day end + 3 h) is the backstop.

## 9. Operating it

| Goal | Command (on the Mac: `ssh isotherm-vps …`) |
|---|---|
| State at a glance | `bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh status` |
| Recent runs | `bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh logs 100`, or `journalctl --user -u isotherm-settle` |
| Next run | `systemctl --user list-timers isotherm-settle.timer` |
| Log in to CRE again | `packages/cre-workflow/vps/relogin.sh isotherm-vps`, run on the Mac itself (section 4) |
| After a writer conflict, once one host settles | `bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh clear-conflict` |
| Ship a code change | `packages/cre-workflow/vps/push.sh isotherm-vps` from the Mac, between :10 and :02, never 17:50–18:30 UTC. It ships the whole `packages/cre-workflow` working tree (uncommitted edits included, `evidence/` excluded), so to ship one reviewed change alone, run it from a clean checkout of that commit (`git worktree`). Its byte-identity check covers the job's files; compare the watchdog's files by `sha256sum` until they are added. Run `vps/setup.sh` again only if the toolchain or `settle/bun.lock` changed. |
| Pause settlement (nothing settles meanwhile) | `systemctl --user stop isotherm-settle.timer`; resume with `start` |

**Alerts**, each with its own dedupe window:
- `report sent <ICAO> <date>`, every time;
- `settle job exit N` (3 h), also when the alerts cannot read the run's evidence record;
- `harness fallback ran` (12 h); its body says whether to act (section 4);
- `CRE LOGIN NEEDED` from the second run in a row without the login (3 h), then `CRE LOGIN RESTORED` once (section 4);
- `attester low on MON` below 0.1 MON (24 h), the first warning; the watchdog's high-priority `ATTESTER LOW` below 0.08
  MON follows only if the treasury's top-ups fail (section 13);
- `WRITER CONFLICT` (every time), then `still stopped` (6 h).

Every alert is also kept in `var/alerts/ALERTS.log`. The stack watchdog (section 13) sends its own `ISOTHERM WATCH:`
pushes and keeps them in `var/watch/alerts/ALERTS.log`.

## 10. Tests run on 2026-10-09 (`evidence/`)

Run `vps/test/run-container-tests.sh all` on a Mac with Docker or OrbStack. It uses Ubuntu 24.04 containers: arm64
natively, and amd64 emulated. The stand-in VPS boots systemd as PID 1 and is reached over SSH like a real one. Nothing
live is sent. No real key, CRE session, launchd job or `~/isotherm-live` is used: the Mac side runs against a stub
`launchctl` and a scratch HOME.

**Where the outputs go (since 2026-10-14).** Each step writes its file into a new directory under `$TMPDIR` and prints
the path. The tracked files below are rewritten only with `ISOTHERM_WRITE_EVIDENCE=1`, and only for a step that passed
(exit 0 and no `FAIL` line); a failed step leaves its tracked file unchanged. The other test scripts of this package
(`test/login-lapse-unit.sh`, `test/relogin-local-sshd.sh`, `test/stack-watch-unit.sh`, `test/watch-systemd-e2e.sh`, and
`scripts/official-retry-check.sh`, `sim-fork.sh`, `harness-fork-check.sh`, `fork-e2e.sh`, `don-gas-fork.sh`,
`don-rehearse-fork.sh`, `jobs-fork-e2e.sh`) follow the same rule, so running a test no longer dirties `git status`.

| File | What it shows |
|---|---|
| `push.txt` | The first `push.sh` to a fresh VPS without rsync uses a tar stream. About 1 MB arrives, and no key, `.env`, `var/`, `.tools/`, `node_modules/` or `*.wasm`. The code checks as byte-identical. |
| `setup-arm64.txt`, `setup-amd64.txt` | `setup.sh` passes on both architectures. CLI v1.37.0, bun 1.4.2 (amd64: the baseline build was chosen automatically, as the emulated CPU reports no AVX2) and cast 1.8.5 are installed. **`cre workflow build` produces `413d4429…`, byte-identical to the Mac's WASM, on both.** The units are installed, linger is on, and a second push uses rsync. |
| `lint.txt` | shellcheck is clean on every new script, apart from two intentional patterns in the test scripts, which are disabled with a comment. The changed shared scripts carry only the findings they had at HEAD. `systemd-analyze verify` passes; the schedule is :05 UTC. |
| `systemd-fork-e2e.txt` | **18 checks** run through the installed systemd unit against an anvil fork of live testnet. The fork reads come from the Ankr RPC, the attester is set on the fork, and the tx key is a fresh random one. Covered: no claim; the 50-minute guard; a harness settlement of RCSS 2026-10-09 with evidence `host: vps` and pushes; the spacing guard; a conflict between runs and during a run, sticky and deduplicated; `clear-conflict`; `release`, after which a preflight still runs in full; a dry run; the timer starting the service. |
| `tripwire-unit.txt` | **11 checks** of the tripwire against the log lines of the OFFICIAL path, which the fork run cannot reach without a CRE login: the real `settle-vps.sh` with a stub job that prints official-path lines and sends real transactions on a local anvil chain. Covered: a logged report; a failed `writeReport` whose transaction used a nonce (no conflict, the next run re-baselines); the same plus another host's transaction (conflict); an unlogged transaction (conflict); a claim after the other host sent in between (no conflict); a report whose `tx 0x… ->` line was dropped, its hash only in the result JSON (no conflict), the same plus another host's transaction (conflict), and a failed `writeReport` whose hash is in the result JSON plus another host's transaction (conflict: the failed report counts once). |
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

## 13. Stack watchdog (judging period, until 2026-10-31)

**Why.** The maker Worker's own alert pushes do not arrive (`docs/OPERATIONS.md` 8.8, 8.9): ntfy.sh answered them with
HTTP 429, its per-IP limit on Cloudflare's shared egress IPs, and by 2026-10-13 with HTTP 401, which means ntfy
rejects the access token the Worker sends; that one does not heal by itself. This VPS pushes from its own IP. So during
judging the VPS also watches the rest of the stack and pushes to the phone when the maker stalls, the books go empty,
the next ladder does not open, the drip or the relayer fails, a bot uses up the day's drips, a balance runs low, a
settlement is overdue, or the RPC the web app reads through fails.

**What a run does** (`stack-watch.sh`, every 10 min at :00/:10/…/:50 UTC, never at :05):
- 4 GETs of the public API: `/api/health`, `/api/snapshot`, `/api/settlements`, `/api/stats`;
- alongside them, the web app's RPC (`https://testnet-rpc.monad.xyz`, `apps/web/src/config.ts` `RPC_URL`) read as a
  browser on the site reads it: its CORS preflight (an OPTIONS) and one `eth_blockNumber` POST, both with
  `Origin: https://isotherm.pages.dev`;
- one GET of the site's `index.html`, plus its main script (about 0.6 MB) once per new build, to learn which of
  `apps/web`'s fallback RPCs (Ankr, thirdweb) the deployed build lists (cached in `var/watch/web-build`); each listed
  fallback is read the same way;
- 5 `cast balance` reads (treasury, maker, operator, guardian, attester; Ankr first, then the official RPC), and
  `Resolver.resultOf` only for a ladder that reached the chain, is past day end + 5 h and is not listed in
  `/api/settlements` yet;
- `var/evidence/settle-runs.jsonl`, the settlement job's evidence records, read (never written) for the digest's CRE
  line, and only on a run that may send the digest;
- then the checks below, the pushes through `lib.sh` `push_alert` (the same `alert-webhook.url` as the settlement
  job, never printed), and its state in `var/watch/`.

It is **read-only**. It sends no transaction, never POSTs to the API (its POSTs are `eth_blockNumber` reads of the web
app's RPCs, its OPTIONS their CORS preflight), holds no key, never writes the settlement job's `var/` files, and never
touches the CRE login or `isotherm-settle.timer`. It runs niced (15), with idle I/O, a 300 MB memory cap and a 60 s
budget for chain reads. A run takes a few seconds (about 20 s live from the Mac); the worst case is about 110 s, well
before :03 (the web RPC reads run alongside the 4 GETs and end inside their 40 s). A start at :03–:09 (a `Persistent`
catch-up after a reboot) is skipped.

| Push (`ISOTHERM WATCH: …`) | Fires when | Priority, repeat | Why this line |
|---|---|---|---|
| `MAKER STALLED` | the snapshot (`receivedAt`) is > 15 min old on a second run, or already ≥ 25 min old; or `/api/snapshot` is empty | high, 3 h | the Worker posts one every minute; one 16-minute gap that heals by itself is no night-time push, ticks that fail on and off are (once) |
| `BOOKS EMPTY` | a strike of an active ladder with fair 0.10–0.90 has no bid or no ask (or that side is fully filled) for > 60 min; not from 15 min before a ladder's close, nothing at all 09:15–09:35 UTC. Once raised, any empty at-the-money strike keeps it open | default, 3 h | outside 0.10–0.90 the maker pulls on purpose; a fill is refilled in a tick or two, so an hour is the quoting cap or a stuck maker |
| `LADDER NOT OPENED <ICAO>` | from 13:00 local (05:00 UTC for Taipei) tomorrow's ladder is not `active` (before 13:00: today's): `planned`, `rolling`, or not in the snapshot at all | high, 3 h | the maker rolls it at 12:00 local and retries a refused roll every 5 min; a normal roll takes minutes. The body names the state and `control.mjs roll` |
| `NO ACTIVE LADDER` | no `active` ladder for > 20 min over 3 runs, outside a close window | high, 3 h | when rolls work, tomorrow's ladder is active before today's closes, so this means nothing can be traded |
| `API UNHEALTHY`, `DRIP DOWN`, `RELAY DOWN` | `/api/health` `ok` false or no relayer; `dripReady` / `relayReady` false, for > 20 min over 3 runs. Not when the day's cap is used, nor when drips or relays are disabled on purpose | high, 3 h | 20 min ignores one RPC hiccup of the API; a good reading in between does not restart the clock |
| `RELAYER LOW` | relayer < 15 MON | high, 6 h | ~2.8 worst-case days at the current caps (17 × 0.260 + 28 × 0.034 = 5.38 MON/day); the body gives the runway to 10-31 |
| `AUSD FLOAT LOW` | float < 5 drips (5,000 AUSD) for > 20 min over 3 runs | default, 3 h | the API's minute cron refills it to 50,000; drips fall back to the public faucet meanwhile |
| `DRIP CAP USED EARLY`, `RELAY CAP USED EARLY` | `dripsToday` ≥ 17 or `relaysToday` ≥ 28 before 08:00 UTC; once per UTC day. After 08:00: `… CAP REACHED` at **low** priority (no sound) | high, once a day | likely a bot (judges took 9 drips in 6 days); the body says what to set back: `docs/OPERATIONS.md` section 0. Later in the day it is heavy use, and 15:00–24:00 UTC is the Taipei night |
| `TREASURY LOW` | treasury < 20 MON | high, 6 h | the judging line of the Worker's own `TREASURY LOW` |
| `MAKER LOW`, `OPERATOR LOW` | maker < 1.0 or operator < 0.9 MON for > 20 min over 3 runs | high, 6 h | the treasury tops them up below 2 and 1.2 every 10 min, so two passes without it means top-ups fail. Operator 0.9, not 0.6: the 04:00 UTC roll needs ~0.85 and is refused below it |
| `GUARDIAN LOW`, `ATTESTER LOW` (added 2026-10-14) | guardian < 0.03 or attester < 0.08 MON for > 20 min over 3 runs | high, 6 h | the treasury tops them up below 0.05 and 0.3, so this means top-ups fail. The guardian pays `challenge()` (about 0.011 MON) and `pause()`: without it a wrong result pays out. The attester sends every report (0.0204 MON): 0.08 is about 3 reports. The settlement job's own `attester low on MON` (< 0.1, default priority, 24 h) is the first warning |
| `WEB RPC DOWN` (added 2026-10-14) | the web app's RPC fails as a browser on the site reads it, on the 3rd run in a row: no answer, not HTTP 200 or no block number; a POST answer whose CORS header does not allow the site; a preflight that is not 2xx, does not allow the site or does not allow `content-type`; or a block that has not moved in 5+ min. A good run resets the count | **high** while no fallback RPC of the deployed build answers (the build live since 2026-10-13 has none: judges see no prices and cannot trade); default while one does, and high again at once if they fail too. Repeats every 3 h | the web app reads, trades and signs (Dynamic) through it first, while the API, the maker and this watch read Ankr first, so nothing else would notice. The body gives the check to run from the Mac for the kind of failure (a CORS failure is never blamed on the VPS's network). Hold it with `--snooze-web HOURS` |
| `SETTLEMENT OVERDUE <ICAO> <date>` | no result on the Resolver by day end + 5 h (21:00 UTC for Taipei), for a ladder that reached the chain (a series or a market) | high, 3 h | the VPS settles at 18:05 and retries hourly: three attempts failed. A roll that never sent a transaction has nothing to settle (`LADDER NOT OPENED` covers it) |
| `WATCH CANNOT REACH THE API` | the 3rd run in a row that cannot read `/api/health` or `/api/snapshot` | high, 3 h | one or two failed runs are network weather |
| `daily digest <date>` | the first run at or after 01:00 UTC (09:00 Taipei) | default, daily | yesterday's drips and relays, the relayer's runway, the treasury, maker, operator, guardian and attester, the ladders (active, next roll), settlements, judge trading, the web RPC's block and the deployed build's fallbacks, the CRE line, open alerts. **No digest by 09:10 Taipei = the watchdog is down** |
| `CLEARED <alert>` | a pushed alert has been gone for 30 min (a `SETTLEMENT OVERDUE`: at once, a result is final) | low, once | it also resets that alert's repeat window |

**Hysteresis.** A problem ends only after 30 min without it (four runs). Until then it keeps its start time, its run
count and its repeat window. So a problem that comes and goes (a maker whose ticks fail on and off, as on 2026-10-09
14:00–15:27 UTC) is one push per repeat window, not a high push and a `CLEARED` per recurrence. A pending problem keeps
counting toward its threshold through a good reading.

**Delivery.** The one-off pushes (the digest, `CAP USED EARLY` / `CAP REACHED`, `CLEARED`, the end-date reminder) are
re-sent on the next runs until `push_alert`'s delivery stamp for that title changes (it is written only on a 2xx
answer): at most 2 re-sends per run, for at most 24 h. A single 429 from ntfy therefore delays them by 10 min instead of
losing them. The other alerts already retry, because their repeat window starts only on a delivered push.

**The digest's CRE line** (since 2026-10-14) says only what the settlement records show: the last official run and its
exit, a stand-down (`STOOD DOWN`, DON or writer released) or a harness run, the last report, and "Login shown from X to
Y on every recorded run". That is a span, not the session's age: a relogin with no miss before it leaves no record. It
also names the largest gap over 2 h between records (and counts the others), single misses (CRE API errors, no
action), a lapse (2+ misses in a row: `CRE LOGIN NEEDED` has the fix), and `NO SETTLEMENT RUN RECORDED SINCE …` when
the newest record is over 2 h old.

A balance read that fails, or an unreadable API, never raises or clears anything; the alert's state is kept. The
maker's quoting spend against its cap (6 MON during judging) is not public (the API strips the snapshot's budget), so
the digest leaves it out: `node scripts/control.mjs status` in `apps/maker-worker` shows it. Details and every
threshold's reasoning are in the comments of `stack-watch.mjs`.

**Install** (from the repository root on the Mac, between :10 and :02):
```bash
packages/cre-workflow/vps/push.sh isotherm-vps                                          # ships vps/ (code only)
ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/stack-watch.sh --dry-run       # what it would push now
ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/install-watch.sh               # both units; timer on
ssh isotherm-vps systemctl --user start isotherm-watch.service                          # optional: the first digest now
ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/install-watch.sh --status      # timer, next run, last run
```
The first run pushes the first digest ("the watchdog is running"), which also proves the push path. `install-watch.sh`
is idempotent and touches only `isotherm-watch.service` and `isotherm-watch.timer`.

**Operate.**
- State: `ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/install-watch.sh --status` (timer, next run, snooze,
  journal). It prints the journal with `-o cat`, so the VPS's hostname never reaches the Mac's terminal.
- Logs: `journalctl --user -u isotherm-watch -n 50 -o cat` (the lines carry their own UTC time; the default format
  would add the hostname).
- Every alert is also in `var/watch/alerts/ALERTS.log`.
- A dry run at any time: `stack-watch.sh --dry-run` pushes nothing and saves no state.
- **Deliberate maker pause** (`control.mjs pull` or `disarm`, the rollback in `docs/OPERATIONS.md` 8.4): snooze the
  maker checks (`MAKER STALLED`, `BOOKS EMPTY`, `LADDER NOT OPENED`, `NO ACTIVE LADDER`) for 1–72 h; the other checks
  keep running, and the digest shows the snooze. End it early with `--snooze 0`.
  ```bash
  ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/stack-watch.sh --snooze 6
  ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/stack-watch.sh --snooze 0
  ```
  This snooze is unchanged by the 2026-10-14 additions: it never holds `WEB RPC DOWN`, the balance checks or the rest.
- **A known web RPC outage** that nobody can fix, or one only this VPS sees: hold `WEB RPC DOWN` alone for 1–72 h with
  `stack-watch.sh --snooze-web HOURS`; `--snooze-web 0` ends it. It writes `var/watch/snooze-web-until`; the digest and
  `install-watch.sh --status` show it while it holds.
- `var/watch/web-build` caches the deployed site's main script name and the fallback RPCs it lists, so the script is
  read again only after a web deploy. If `apps/web`'s `FALLBACK_RPC_URLS` changes, update `WEB_FALLBACKS` in
  `stack-watch.sh`: a fallback it does not know is ignored, which keeps `WEB RPC DOWN` at high priority (the safe side).

**Remove it after 2026-10-31** (with the rest of the judging override, `docs/OPERATIONS.md` section 0):
```bash
ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/install-watch.sh --uninstall           # keeps var/watch/
ssh isotherm-vps bash isotherm/packages/cre-workflow/vps/install-watch.sh --uninstall --purge   # also deletes it
```
From 2026-11-01 the watchdog stops checking (its thresholds are the judging ones) and pushes one low-priority
reminder a day to uninstall it.

**Tests** (local only, `evidence/`; each writes a kept report under `$TMPDIR` and prints its path, and
`ISOTHERM_WRITE_EVIDENCE=1` writes the tracked file only from a passing run):
- `stack-watch-unit.txt` (macOS `/bin/bash` 3.2) and `stack-watch-unit-bash5.txt` (GNU bash 5.2, Linux container,
  no network): **156 checks** of every alert, positive and negative, with fixtures and stubs. They cover the close
  window, before the roll, a stuck or missing roll, the 3-run threshold, dedupe and the 30-min clear, problems that
  come and go (a maker failing on and off, API reads failing 3 runs out of 4, a drip outage with a good reading every
  20 min), a 429 from ntfy, the snooze, the digest once a day, `--dry-run` pushing and saving nothing, the :03–:09
  skip, the lock, malformed API data and a failing evaluator. Since 2026-10-14 also: the web RPC (each CORS failure
  kind, a stuck block, the deployed build's fallbacks answering or not, the build cache, `--snooze-web`), the guardian
  and attester lines, and the CRE line (single misses, a lapse, stale records, a gap, a stand-down, the records read
  only on a run that may send the digest). They also check that no push went anywhere but `https://ntfy.invalid`, that
  no real GET or `cast` call was made, and that the only POST and OPTIONS are the web RPC reads.
- `watch-systemd-e2e.txt`: **23 checks** of the units and `install-watch.sh` under a real systemd user manager in the
  Ubuntu 24.04 test container, with no network. Covered: root refused; render, verify and enable; idempotent; the
  schedule never at :03–:09; one run through systemd with Nice, idle I/O, CPUWeight and MemoryMax applied, the
  settlement records read and left byte-identical; `--status` without the hostname, with a snooze and a web snooze set
  and ended; uninstall and purge; the settlement units untouched.
- `stack-watch-live-dryrun.txt`: one `--dry-run` from the Mac against the live API, the live web RPC and site, and live
  testnet reads (2026-10-14 06:00 UTC), with `ISOTHERM_ALERT_URL_FILE=/nonexistent` and a read-only copy of the VPS's
  settlement records: all healthy; it shows the live build (`index-Cd8KBz0E.js`) has no fallback RPC and the records'
  20 h gap (2026-10-11 18:05 to 10-12 14:05 UTC). Not yet run on the VPS's own bash 5.3.9 / curl 8.18: run the unit
  suite and a `--dry-run` there after the next push.

**Limits.**
- It samples every 10 min, so "60 min" means 60–70 min.
- If the VPS itself is down, nothing pushes: the missing 09:00 Taipei digest is the signal.
- It watches what the public API, the chain and the web app's RPC show. The Worker's internal errors appear only as
  their effects (a stale snapshot, empty books, a ladder that does not open, low balances). Its integrity alerts
  (`MISMATCH`, `CHALLENGE FAILED`, `UNVERIFIED`, the stale-void alerts, `RESERVE METER OVER`, `RPC ENDPOINT
  EXCLUDED`) have no phone route until the Worker's own push works again (`docs/OPERATIONS.md` section 0).
- `WEB RPC DOWN` reads the web app's RPC from the VPS's IP, not a judge's. A failure that the Mac's check does not
  reproduce is this IP's problem (snooze it with `--snooze-web`); the body says which check to run.
- The API does not publish the maker's `paused` flag, so a deliberate pull needs the snooze.
- `LADDER NOT OPENED` knows the stations from their ladders in the snapshot (remembered 4 days). A station taken out
  of the maker's config would be reported for those days; snooze or ignore it.
