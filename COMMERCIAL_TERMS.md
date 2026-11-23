# Commercial terms — using Smart Guard in another swap front-end

This document describes how a third-party swap product can license **Smart Guard** (this guard
engine) and what it costs. It is a commercial offer with a measurement method, not a license grant
and not a technical enforcement.

## The offer

Run your own swap front-end with our pre-sign guard, and pay **10% of the integrator commission
that your product actually collects**. Nothing else. No listing fee, no minimum, no revenue share
on volume you did not charge for.

```
royalty = 10% of what lands on YOUR Jupiter referral accounts
```

## What the base is, precisely

Jupiter lets an integrator point one `referralAccount` per swap and split the fee with it. Jupiter
keeps 2,000 bps *of the fee itself* (not of the swap), so **80% of what you advertise is what
actually reaches you.** The royalty is calculated on that landed amount, not on the rate you
display, so Jupiter's own share is never part of the base and never paid twice.

| Your advertised fee | Lands on your referral PDA | 10% royalty | Effective cost, % of swap volume |
|---|---|---|---|
| 50 bps (0.50%) | 40 bps | 4 bps | 0.04% |
| 100 bps (1.00%) | 80 bps | 8 bps | 0.08% |
| 255 bps (2.55%) | 204 bps | 20.4 bps | 0.204% |
| 0 bps (free product) | 0 | 0 | 0% |

Charged per mint, in the token the fee arrived in, rounded down:

```
due[mint] = floor( received[mint] × ROYALTY_BPS / 10_000 )   // ROYALTY_BPS = 1_000
```

Rounding down per mint means the sum can never exceed what is owed; the residual dust stays with
the partner.

## Why this base and not something else

- **It is the only number that is publicly measurable.** The fee is a token-balance change on
  accounts owned by your Jupiter referral PDA. Anyone with a mainnet RPC can recompute it with
  `getSignaturesForAddress` + `getTransaction`; no shared secret, no trusted dashboard, no
  "take our word for it".
- **It survives a router change.** We read pre/post token balances of the referral-owned accounts,
  not instruction layouts, so a change in Jupiter's route shape does not change the number.
- **A fee you waive is a fee you do not pay on.** Percentage-of-commission cannot punish a free
  product, which is what we want: the goal is adoption, not a toll booth.

The arithmetic is not hidden in a billing backend: `ROYALTY_BPS` and `royaltyDue()` ship in this
package (`src/royalty.ts`) with tests, and the SpaceSwap revenue dashboard computes the number you
see from the same function. Run the four steps below against a public RPC and you get the invoice
without asking us for anything.

## Audit

Both sides run the same public computation and compare:

1. For each supported mint, derive the associated token account of your Jupiter referral PDA
   (seeds `referralPDA, tokenProgram, mint`) — that account is where your share of the fee lands.
2. Walk its transactions with a per-account cursor, newest signature first.
3. For each successful transaction, take the net balance change of accounts owned by the PDA.
4. Sum per mint, apply the formula above.

A partner's own revenue view and our invoice are produced by the same code path on the same chain
data. A disagreement is a diff between two signature lists, which is an hour of work, not a dispute.

## Settlement

- Monthly, in arrears, per mint, in the token the fee was received in (SOL, USDC, JUP today).
- Paid on-chain to the licensor wallet named in the agreement.
- A period with `received = 0` produces no invoice and no obligation.

## What this document deliberately does not claim

- **It does not change the license of what is already published.** Everything released under MIT
  before this document — including the commits now on `main` — stays MIT and royalty-free
  permanently. MIT grants use "without restriction"; a README cannot retract it. From here on, the
  copyright holder reserves the right to put future versions under a paid or restricted license,
  and the terms below are what we propose to charge under such an agreement.
- **Nothing here is enforced by code.** The guard does not call home, does not check a license key
  and will keep working if you never pay. The instrument is the signed agreement, and the reason to
  keep it is that the measurement is public and the reputational cost of an auditable non-payment
  is high. If you need a technical gate, ask — that is a different product, not this one.
- **The rate is one constant today.** `ROYALTY_BPS = 1_000` applies uniformly; per-partner rates
  exist only in a signed agreement, not in configuration.
- **The reference indexer walks three mints.** It derives the referral token accounts for SOL,
  USDC and JUP. If your product charges in another mint, the arithmetic above still applies but the
  current implementation will not see it until that mint is added — say so in the agreement rather
  than discovering it at settlement.
- **Using the guard does not give you our fee.** Jupiter accepts a single `referralAccount` per
  swap. A partner either points that field at its own PDA and settles the 10% monthly, or points it
  at ours and collects nothing. This agreement is the first option.

## To sign

Open an issue or write to the maintainer of [spaceswap.pro](https://spaceswap.pro) with: your
front-end, your Jupiter referral PDA, and the wallet you will settle from. The agreement names
those three things and nothing else needs to be trusted.
