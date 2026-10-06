# Isotherm end-to-end (run from this folder, or `make -C spikes/e2e <target>` from the repo root)
SHELL := /bin/bash
export PATH := $(PATH):$(HOME)/.foundry/bin
ROOT := $(abspath ../..)

.PHONY: fork-e2e forge-e2e testnet-preflight testnet-e2e testnet-e2e-rcss

## Real txs on an anvil fork of live testnet; prints the step/gas table and writes logs/live-requirements.json
fork-e2e:
	./run-fork.sh

## Same loop in-process (forge, exact asserts), pinned to logs/fork_block.txt
forge-e2e:
	cd $(ROOT) && MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FORK_BLOCK=$$(cat $(CURDIR)/logs/fork_block.txt) \
	  forge test --match-path 'test/integration/*' -vv

## Read-only: live balances vs. what one live run needs (from the last fork run). Exit 0 = ready.
testnet-preflight:
	npx tsx ts/preflight.ts

## THE one command for the real testnet (10143): preflight, then the full loop with a throwaway fast-settling test
## station (whole loop incl. CRE settlement + redeem in ~15-25 min). Spends testnet MON only. Refuses any other chain.
testnet-e2e: testnet-preflight
	cd $(ROOT) && forge build >/dev/null
	MODE=live npx tsx ts/e2e.ts

## Same, but on the real Taipei (RCSS) day: waits until 00:00 Taipei for settlement (resumable with RESUME=<state.json>)
testnet-e2e-rcss: testnet-preflight
	cd $(ROOT) && forge build >/dev/null
	MODE=live LIVE_STATION=RCSS npx tsx ts/e2e.ts
