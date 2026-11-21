# Smart Shield rulebook — every check, every code

This is the complete list of guard issues SpaceSwap evaluates on **every swap, before your wallet is
ever asked to sign**. Each row names the trigger, the verdict level, and the file/function that
implements it, so you can jump straight to the code and the matching test.

- `block` — the swap is refused before signing. A blocked attempt costs no network fee.
- `warn` — the swap continues, but the fact is displayed in the confirm panel you have to accept.

## 1. Request sanity — `src/rules.ts :: validateSwapRequest`

| Code | Level | Trigger |
|---|---|---|
| `INVALID_MINT` | block | Input or output mint is not a valid base58 public-key format |
| `SAME_TOKEN` | block | Swapping a token for itself |
| `INVALID_AMOUNT` | block | Amount is not a positive integer in base units |
| `INVALID_SLIPPAGE` | block | Slippage not an integer in 1..`MAX_SLIPPAGE_BPS` (500 bps) |

## 2. Quote freshness — `src/rules.ts :: evaluateQuoteFreshness / assertOrderSignable`

A swap is only signable while the audited price is still the price the router quoted.

| Code | Level | Trigger |
|---|---|---|
| `QUOTE_STALE` | block | Quote older than `QUOTE_MAX_AGE_MS` (20 s) |
| `RFQ_EXPIRED` | block | The RFQ offer's own `expireAt` has passed |
| `BLOCKHASH_EXPIRING` | block | `lastValidBlockHeight` within `BLOCK_EXPIRY_SAFETY_MARGIN` (5) blocks |
| `BLOCK_HEIGHT_MISMATCH` | warn | RPC reports block height on an incomparable scale — freshness not verified; a dead blockhash simply never lands, funds are not lost |
| `EMPTY_TRANSACTION` | block | Router returned a quote with no transaction to sign |
| `UNSUPPORTED_TX_VERSION` | block | Only version-0 transactions are audited, so only those are accepted |
| `FEE_SETUP_REQUIRED` | block | Platform fee unconfigured — better to refuse than to swap with an unaudited fee path |

## 3. Route and price warnings — `src/rules.ts :: evaluateQuoteWarnings`

| Code | Level | Trigger |
|---|---|---|
| `HIGH_SLIPPAGE` | warn | Slippage above `HIGH_SLIPPAGE_WARNING_BPS` (100 bps) |
| `UNKNOWN_ROUTER` | warn | Jupiter returned a router outside the observed set (`metis`, `jupiterz`, `dflow`, `okx`) |

## 4. Instruction decode — `src/transaction.ts :: inspectSwapTransaction`

Every top-level instruction of the transaction bytes is decoded before signing.
A legitimate swap **never** grants authority over your tokens, so any of these is a hard block:

| Code | Level | Trigger |
|---|---|---|
| `DRAIN_SET_AUTHORITY` | block | SPL/Token-2022 instruction discriminator 6 (`SetAuthority`) on your account |
| `DRAIN_APPROVE` | block | Discriminator 4 (`Approve`) — delegates spending rights that outlive the swap |
| `DRAIN_APPROVE_CHECKED` | block | Discriminator 13 (`ApproveChecked`) — a scoped delegation is still a delegation |
| `TOKEN_2022_IN_TX` | warn | Transaction touches Token-2022 (extensions may exist; see §6) |
| `UNKNOWN_PROGRAM` | warn | A program outside `KNOWN_PROGRAMS` is called and it is not the router Jupiter declared for this build — its logic cannot be verified here, so it is named in full for you to look up |
| `UNRESOLVED_ACCOUNTS` | warn | Some lookup-table addresses could not be resolved locally |

`KNOWN_PROGRAMS`: System, SPL Token, Token-2022, ATA, Compute Budget, Memo, Jupiter
(`JUP6Lkb…`), Jupiter Referral. Unknown programs warn rather than block so that a new Jupiter
routing program never silently disables trading — the decision is disclosed to you, not made for you.

`ROUTER_PROGRAMS` — Jupiter's swap API is a meta-aggregator: when it does not route a pair itself it
hands the build to another router and names it in the `router` field of the same response that carried
the transaction. That program then replaces `JUP6Lkb…` at the top level, so the guard treats exactly
the declared one as expected:

| `router` | Program | Who it is |
|---|---|---|
| `metis` | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | Jupiter's own router |
| `okx` | `proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u` | OKX DEX router |
| `dflow` | `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH` | DFlow router |
| `jupiterz` | `61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH` | Jupiter Z |

Two deliberate choices here. The caller passes the *name* Jupiter returned, never an address, so no
integration can mark its own program trusted. And a router other than the declared one still warns:
a transaction calling OKX while Jupiter reported `metis` is precisely the mismatch worth showing you.
Every address above was read off a transaction Jupiter built under that name on mainnet (2026-11-21),
and a router missing from this table still only warns — it never blocks your swap.

## 5. Pre-sign pipeline — `src/presign-audit.ts :: preparePreSignAudit`

The wiring: order-vs-request equality, signer identity, the **writable-account bound**, then §2–§6
in one pass. Any `block` throws `SwapGuardError` before the wallet prompt.

| Code | Level | Trigger |
|---|---|---|
| `ORDER_MISMATCH` | block | Returned order differs from what you asked to swap |
| `FEE_MINT_UNSUPPORTED` | block | Fee charged in a token outside the pair — cannot be shown transparently |
| `TAKER_NOT_SIGNER` | block | Your address is not a signer of the transaction |
| `UNRESOLVED_ACCOUNTS` | block | RPC would not answer the transaction's address lookup tables — an unverifiable transaction is refused, not signed |
| `DRAIN_WRITABLE_ACCOUNT` | block | The transaction makes **another** token account you own writable, outside this swap's route. The writable set is frozen at signing and bounds every inner CPI call, so this is the reach a hidden inner instruction would need. Your input, output and route-hop ATAs are the only expected user accounts |
| `RPC_UNAVAILABLE` | warn | Block height or token accounts could not be read — the unverified fact is disclosed instead of assumed |

## 6. Token-2022 issuer powers — `src/presign.ts :: parseMintRisk / mintRiskIssues`

Decoded straight from the mint account's TLV extension stream. These are issuer custody powers, not
proofs of theft — regulated tokenized equities ship with them by design — so they are disclosed and
**gated behind an explicit consent checkbox** instead of silently allowed or blanket-banned:

`ISSUER_PERMANENT_DELEGATE`, `ISSUER_TRANSFER_HOOK` (consent-gated), `MINT_FREEZE_AUTHORITY`,
`MINT_CLOSE_AUTHORITY`, `MINT_TRANSFER_FEE`, `MINT_NON_TRANSFERABLE`, `MINT_DEFAULT_FROZEN`,
`MINT_PAUSABLE` — all `warn`.

## 7. Post-signature simulation — `src/poststate-audit.ts` + `src/presign.ts :: postStateAuthorityIssues`

The exact bytes you are about to sign are simulated (`sigVerify: false`), and your token accounts'
**authority fields** are diffed pre/post: `delegate`, `owner`, `closeAuthority`. Amounts legitimately
change during a swap; authorities never should. This is what catches a drain hidden inside a nested
CPI call that the static decode cannot see.

| Code | Level | Trigger |
|---|---|---|
| `POST_STATE_AUTHORITY_CHANGED` | block | Simulation shows the swap would leave a permanent authority change on one of your accounts |
| `SIMULATION_EXECUTION_FAILED` | block | The transaction fails on-chain when simulated — consent cannot make a failing swap succeed |
| `POST_STATE_UNAVAILABLE` | warn | RPC gave no simulation verdict: disclosed before you sign; your signature is then your informed choice to send without this second check |

## 8. Wallet tamper check — `src/message-equality.ts :: classifyMessageChange`

After you sign, the wallet returns a transaction. Before anything is sent to Jupiter, the signed
message is compared **semantically** (accounts + roles + instruction effects, not raw bytes, so an
honest wallet's re-encoding still passes):

| Verdict | Meaning |
|---|---|
| `unchanged` | Signed exactly as audited |
| `benign-additions` | Wallet only appended Compute Budget / Memo, or an assertion program (Lighthouse) whose new writable account is then proven in the network before sending |
| `wallet-fees-only` | Wallet replaced Jupiter's compute budget with its own, under a hard ceiling of 0.01 SOL worst-case priority fee |
| `modified` | Anything else — **never sent**. The refusal names the changed field, the added program in full, and the new accounts money could move to |

## 9. Reading a verdict in your own words — `GuardIssue.params`

Every issue carries `level`, `code`, an English `message` (a safe fallback) and, when the verdict
embeds data the rule only knows at runtime, a locale-neutral `params` object. `code` + `params` are
the contract a UI renders from; `message` is never parsed to make a decision and never changes a
verdict. Placeholder names are fixed so a consumer's localized template can drop them straight in:

| Code | `params` |
|---|---|
| `INVALID_SLIPPAGE` | `{ max }` |
| `UNKNOWN_PROGRAM` | `{ program }` — full base58, the `message` truncates it |
| `ISSUER_PERMANENT_DELEGATE` | `{ mint, delegate }` |
| `ISSUER_TRANSFER_HOOK` | `{ mint, hook }` |
| `MINT_FREEZE_AUTHORITY` / `MINT_CLOSE_AUTHORITY` | `{ mint, authority }` |
| `MINT_TRANSFER_FEE` / `MINT_NON_TRANSFERABLE` / `MINT_DEFAULT_FROZEN` / `MINT_PAUSABLE` | `{ mint }` |
| `POST_STATE_AUTHORITY_CHANGED` / `DRAIN_WRITABLE_ACCOUNT` | `{ accounts }` |
| `SIMULATION_EXECUTION_FAILED` | `{ error }` |

A purely static verdict (e.g. `SAME_TOKEN`) carries no `params`. See `test/params.test.ts` for the
assertions that lock this table.

## How to convince yourself

`npm test` runs 82 tests, 75 of them building **real version-0 transactions** — a legitimate Jupiter-shaped
swap and staged drains — and assert each rule fires (or stays silent) exactly as documented:
top-level Approve/SetAuthority/ApproveChecked, CPI-reachable extra writable accounts, delegate
changes found only by simulation, wallet re-signature tampering, stale quotes, consent-gated
Token-2022 powers, and the full `preparePreSignAudit` pipeline against injected fake RPC data.
No wallet, no network, no SpaceSwap account required.
