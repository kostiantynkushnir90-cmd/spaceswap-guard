# Smart Shield threat model

What the SpaceSwap guard protects, against whom, and — just as importantly — what it does **not** claim.

## What we protect

Your **wallet authority**: the permanent rights over your token accounts (owner, delegate, close
authority) and the funds reachable through them. A swap should never be able to leave any of those
rights changed. Secondarily: the price you agreed to (the on-chain minimum-output floor) and the
integrity of what you sign (what you approve is what gets sent).

## Non-custody is the first line

SpaceSwap never holds keys. The worst it can do to you with its own backend compromised is show a
bad quote — the transaction still requires **your** signature, and the last thing to touch it before
the network is your wallet. Everything below protects the signing decision itself.

## Attacks considered and mitigated

| Attack | Mitigation (RULES.md §) | Enforcement |
|---|---|---|
| Airdrop-drain "claim" that Approves or re-authorities your token account | Top-level instruction decode blocks discriminators 4/6/13 (§4) | Guard refusal, before the wallet prompt |
| Drain hidden inside a nested CPI call, no visible Approve instruction | (a) Writable-account bound: any extra user-owned writable token account blocks the swap (§5). (b) Simulation of the exact signed bytes with a pre/post diff of `delegate`/`owner`/`closeAuthority` (§7) | (a) guard; (b) the Solana runtime itself makes the writable set binding for every inner call — the guard only decides whether the set is safe |
| Getting less than quoted (sandwich/slippage extraction) | `minOut` is decoded from Jupiter's own route instruction and enforced on-chain by the router program (§5, `auditMinOut`); quote freshness gates (§2) | Jupiter program on-chain, not a promise |
| Wallet returns a different transaction than was audited | Semantic message comparison after signing (§8) | Never sent; the diff is shown to the user |
| Malicious wallet / tampered signature path | Signer slots, blockhash, roles and instruction byte-equivalence must match audited values; new accounts from benign additions must be proven in-network first (§8) | Guard refusal |
| Rug-token mechanics (freeze, permanent delegate, transfer hook, pausable, …) | Mint state decoded from chain and disclosed; custody powers require explicit consent (§6) | Consent gate in the confirm panel |
| Stale/manipulated price data | Quote age, RFQ expiry, blockhash margin, router allowlist (§2, §3) | Guard refusal / warning |
| Unverifiable transaction bytes | Unresolved lookup tables are a hard block, not a shrug (§5) | Guard refusal |

## What Smart Shield explicitly does NOT do

We would rather you learn this here than discover it:

1. **It cannot read arbitrary program logic.** Unknown programs are named and warned about, not
   analyzed. A legitimate new routing program would otherwise silently break trading for everyone.
2. **It cannot verify a transfer hook's code.** Token-2022 hooks execute issuer-controlled programs
   at transfer time. We disclose them and require your consent; the code itself is opaque.
3. **It is not an asset-quality oracle.** It will not tell you whether a token is a bad investment,
   whether LPs are locked, or whether the mint authority will dump supply. It tells you exactly which
   custody powers exist (§6) so you can decide.
4. **It cannot prevent losses outside the swap path.** If you sign a malicious transaction in another
   dApp, paste a poisoned address elsewhere, or fall for phishing, Smart Shield is not in that loop.
   Our bound applies to swaps executed through SpaceSwap.
5. **State can still change between simulation and execution.** The simulation is a very strong
   filter, not a time machine; the runtime's own checks (min-out floor, blockhash expiry) are the
   backstop for the gap.
6. **When a check cannot run, we say so.** `POST_STATE_UNAVAILABLE` / `RPC_UNAVAILABLE` warnings mean
   a fact was not verified and you decide — the guard never converts "couldn't check" into "checked,
   all clear."

## Trust boundaries

- **Solana runtime**: writable-set enforcement, on-chain min-out, blockhash expiry.
- **Jupiter**: route construction and swap execution. SpaceSwap audits the transaction Jupiter
  returns rather than trusting that it is inert.
- **Your wallet**: the signature. The post-signature diff means the wallet's behavior is also checked.
- **Us**: every guard decision is visible in the confirm panel, and — via this repository —
  inspectable and runnable yourself.

## Reviewing this repository against production

See README §"Reviewed = deployed": rule constants and program IDs here are compared byte-for-byte
against the deployed backend's guard sources, and any divergence is a bug we want reported.
