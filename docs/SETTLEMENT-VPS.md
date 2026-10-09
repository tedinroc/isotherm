# Moving the settlement job off the Mac (VPS kit)

**Status (2026-10-09).** A ready-to-use kit is prepared and rehearsed in Ubuntu 24.04 containers. **Nothing is deployed**,
and the Mac still settles. The full runbook is in `packages/cre-workflow/vps/README.md`.

## Why

Since 2026-10-08 the maker, the daily roll, the kill switch and the challenge watcher run on the Cloudflare Worker
(`docs/OPERATIONS.md` §8). Only the hourly CRE settlement job (`xyz.isotherm.cre-settle`) still needs the Mac to stay
awake. A Worker cannot run the official CRE CLI; a small Linux VPS can. Judging runs from Oct 14 to Nov 3.

## What changes and what does not

- **Unchanged.** The VPS runs the same `scripts/settle-job.sh`, hourly at :05, under a systemd timer instead of launchd:
  - the official path: `cre workflow simulate ./settle -T testnet --broadcast`, CLI v1.37.0, SHA-256-pinned;
  - the labelled harness fallback;
  - the same lock and 30-minute spacing guard;
  - one evidence record per run, now with `"host"`;
  - the same stand-down once settlement moves to the Chainlink DON.
- **Byte-identical code.** On Linux, `cre workflow build` produced the Mac's WASM hash `413d4429…` on both arm64 and
  amd64.
- **Keys.** The attester key is copied to the VPS. The guardian key and the challenge watcher stay on the Worker, so
  signing and challenging remain on different machines.
- **Cost.** About $5–7 a month for a 1 vCPU / 1 GB VPS, which is the owner's purchase. No extra MON: 0.0204 MON per
  report, as today.

## Two settlers never run at once

| Rule | What it means |
|---|---|
| A **claim** on the VPS | The VPS signs nothing until `vps/cutover.sh` gives it the claim. The script does that only after the Mac job is unloaded and disabled. |
| A **released** marker | A host that handed settlement over never signs again until the role is handed back, including manual runs. |
| A **50-minute** handover gap | The new writer waits until the old writer's last run is at least 50 minutes old. |
| A free **on-chain tripwire** | The sender's nonce is read before and after each run. Any transaction the VPS did not send stops it and pushes a high-priority alert, and the other host keeps settling. |

The rollback always releases the VPS before it re-enables the Mac, and the handover names one VPS: a cutover to a
second VPS, or a rollback that names another one, is refused. These rules were rehearsed end to end: 18 checks through
the real systemd unit on an anvil fork, 7 checks of the tripwire against the official path's log lines, and 14 checks
of the cutover and rollback scripts, including a second cutover after a rollback.

## Owner steps, in order

1. Buy a VPS (shortlist in the runbook, §2): Ubuntu 24.04, 1 GB plus swap or 2 GB, IPv4, SSH key. Add a `~/.ssh/config`
   alias `isotherm-vps`.
2. `packages/cre-workflow/vps/push.sh isotherm-vps --setup`
3. Log in to CRE through an SSH tunnel:
   `ssh -t -L 53682:127.0.0.1:53682 isotherm-vps bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh login`
4. Copy the attester key (`scp`, `chmod 600`), then run `isotherm-vps.sh preflight`. Optionally add the ntfy push
   (ntfy only: if the Worker's push URL is a Telegram bot, give the VPS an ntfy topic URL instead; runbook §5).
5. Run `isotherm-vps.sh dry-run` and expect `path=official`, `exit 0`.
6. In a UTC window of :16–:49, outside 16:40–19:20 UTC, run `vps/cutover.sh isotherm-vps` (dry run), then add
   `--execute`.
7. Watch the first VPS run and the night's 18:05 UTC report. To go back: `vps/rollback.sh isotherm-vps --execute`.

**Not verified here** (it needs the owner's account): the CRE sign-in itself on a VPS and how long its session lasts.
The tunnel and callback mechanics were verified.
