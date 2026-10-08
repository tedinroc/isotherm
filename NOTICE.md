# Third-party notices

The Isotherm code is MIT-licensed (see `LICENSE`). Third-party components in this repository keep their own licenses:
- lib/openzeppelin-contracts (MIT) and lib/forge-std (MIT or Apache-2.0).
- Interfaces and ABIs derived from Kuru-Labs/Kuru-contracts-dex-public
  (commit 2060bb2, GPL-2.0-or-later) are GPL-2.0-or-later, as marked by the
  SPDX header in each such file:
    src/interfaces/IKuru.sol
    spikes/kuru/src/interfaces/IKuru.sol
    spikes/e2e/src/IsothermZap.sol (its inline Kuru interface declarations
      were taken from the same source, so the whole file is GPL-2.0-or-later)
  JSON ABIs of those interfaces are GPL-2.0-or-later as well (JSON has no
  header): packages/abi/IKuru*.json, packages/mm-plugin/assets/abi/IKuru*.json
  and spikes/kuru/abi/Kuru*.json.
  The comment-only SPDX relabel of src/interfaces/IKuru.sol came after Sourcify
  verification; the executable bytecode is identical
  (docs/evidence/docs-pass/ikuru-header-bytecode-check.txt).
  The full GPL-2.0 text is in LICENSES/GPL-2.0-or-later.txt.
- src/IsothermZap.sol is MIT, but it imports src/interfaces/IKuru.sol, so the
  compiled IsothermZap (including the deployed, Sourcify-verified contract)
  contains GPL-2.0-or-later interface declarations and is distributed as a
  combined work under GPL-2.0-or-later terms. Its complete source is in this
  repository and on Sourcify.
- Weather data and other third-party data in this repository keep their own
  terms; see DATA-NOTICE.md.
See README.md, "Third-party code", for the full list.
