# spaceswap-guard — Smart Guard, in the open

> *"How will users independently verify these security checks before trusting SpaceSwap with their wallets?"*
> This repository is our answer. It is the pre-sign security engine of [SpaceSwap](https://spaceswap.pro)
> — the Solana swap aggregator that never touches your keys — published under MIT with runnable tests.

SpaceSwap is non-custodial: there is nothing to "hand" us. The one moment of real power is your
signature. Smart Guard is everything that happens before it: the transaction you are about to sign
is decoded, bounded, simulated and diffed — and any swap that would grant lasting authority over your
tokens is refused before your wallet is even asked.

## Verify it yourself in 60 seconds

```bash
git clone <this repo> && cd spaceswap-guard
npm install
npm test
```

`npm test` runs 82 tests. 75 of them build **real version-0 Solana transactions** — a legitimate
Jupiter-shaped swap plus staged attacks — and assert exactly which checks fire:

- a hidden `Approve` / `SetAuthority` / `ApproveChecked` anywhere in the transaction → hard block;
- a drain reachable only via CPI (extra writable account of yours) → hard block;
- an authority change findable only by simulating your signed bytes → hard block, **before** signing;
- your wallet signing something different from what was audited → refused, with the diff explained;
- the same tests proving legitimate swaps (multi-hop routes, ATA creation, wallet priority fees) pass.

No wallet, no RPC endpoint, no SpaceSwap account, no network access needed.

The remaining 7 tests pin the royalty arithmetic — 6 for the 10% of the integrator commission that
lands on a partner's own referral accounts, which is what [`COMMERCIAL_TERMS.md`](COMMERCIAL_TERMS.md)
bills — and 1 for the router catalog in §4 below.

To run the guard in your own product instead of reading it: `npm install spaceswap-guard`. The
published package ships compiled `dist/` plus types, and the same 82 tests pass straight out of
`node_modules` (`node --test "dist/test/*.test.js"`).

## What is in here

| File | Role |
|---|---|
| `src/rules.ts` | Request sanity, quote freshness, slippage/router warnings, signability |
| `src/transaction.ts` | Instruction decode: every top-level instruction, drain discriminators, program allowlist |
| `src/presign.ts` | Parsers (token accounts, Token-2022 mint TLV), `minOut` audit, writable-account bound, post-state authority diff |
| `src/poststate-audit.ts` | Pre-sign simulation orchestration over your route's accounts |
| `src/presign-audit.ts` | The full pipeline that wires the above into one pre-sign decision |
| `src/message-equality.ts` | Semantic before/after-signature comparison — what a wallet may still do, and what never ships |
| `src/royalty.ts` | `ROYALTY_BPS` and `royaltyDue()` — the per-mint BigInt arithmetic behind the commercial terms |
| [`RULES.md`](RULES.md) | Every issue code: trigger, level, implementing function |
| [`THREAT_MODEL.md`](THREAT_MODEL.md) | What this protects against — and the six things it explicitly does **not** claim |
| [`COMMERCIAL_TERMS.md`](COMMERCIAL_TERMS.md) | Running the guard in your own swap product: the 10%-of-commission royalty and how both sides measure it |

## Reviewed = deployed

This package is a faithful port of the guard running in production today:

- The backend serving [spaceswap.pro](https://spaceswap.pro) applies these same checks before it ever asks your wallet to sign. We deliberately do not publish deployment identifiers or internal source paths — this claim is checkable by behaviour, not by our build log.
- Every program ID constant and numeric limit in this package is compared against the production guard — same discriminators (4/6/13), same `KNOWN_PROGRAMS`, same 20 s quote window, 500/100 bps slippage bounds, 5-block hash margin, 0.01 SOL wallet-fee ceiling.
- The only intentional difference: user-facing `message` strings here are English, while production renders localized text. Production builds that text from each issue's `code` + structured `params` (see [`RULES.md`](RULES.md) §9), not by parsing this English string — so localization changes nothing about what is decided. Messages never affect a verdict: decisions depend solely on codes, levels, params and the logic you can read here.

The honest next step after publication is collapsing the duplication: the backend imports this
package, and then the deployed code **is** the reviewed code. Until then, divergences between this
repository and production are bugs — please report them.

## What we will not pretend

See [`THREAT_MODEL.md`](THREAT_MODEL.md) §"What Smart Guard explicitly does NOT do". Short version:
we cannot read arbitrary programs' logic, we cannot verify transfer-hook code, this is not an
investment-advice oracle, and when a check could not run we tell you instead of guessing.

## Post-swap accountability

Every swap additionally produces a **trade passport** — quoted vs. actual amounts, fee, route,
slippage, and a public explorer link — so the guard's promises are checkable after settlement too,
on-chain and by anyone.

## License

MIT — see [LICENSE](LICENSE). Use this code in your own products; attribution appreciated, audits welcome.

## If you run a swap product

The code license above is free and stays free. Separately, we will license Smart Guard as the
pre-sign engine of your own front-end for **10% of the integrator commission your product
actually collects** — measured on public chain data, auditable by you down to the signature. Terms,
arithmetic and the honest limits of that agreement: [`COMMERCIAL_TERMS.md`](COMMERCIAL_TERMS.md).
