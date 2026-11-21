// Proves the structured `params` contract: every guard issue that embeds dynamic data (a mint, an
// address, a program id, a network error) also carries it as a locale-neutral key so a consumer can
// render its own localized sentence. The `message` stays an English fallback; params never change a
// verdict, only what the user can read about it.
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Buffer } from "node:buffer";
import { MAX_SLIPPAGE_BPS } from "../src/constants";
import { validateSwapRequest } from "../src/rules";
import { inspectSwapTransaction } from "../src/transaction";
import { mintRiskIssues, parseTokenAccount, postStateAuthorityIssues, type MintRisk } from "../src/presign";
import { compile, encodeTokenAccount, makeActors } from "./fixtures";

const actors = makeActors();

describe("GuardIssue.params — locale-neutral facts behind each verdict", () => {
  test("INVALID_SLIPPAGE carries the ceiling as {max}", () => {
    const issues = validateSwapRequest({
      inputMint: actors.mintIn.toBase58(),
      outputMint: actors.mintOut.toBase58(),
      amount: "1",
      slippageBps: MAX_SLIPPAGE_BPS + 1,
    });
    const slippage = issues.find((issue) => issue.code === "INVALID_SLIPPAGE");
    assert.equal(slippage?.params?.max, String(MAX_SLIPPAGE_BPS));
  });

  test("a static verdict carries no params (params are only for dynamic data)", () => {
    const same = validateSwapRequest({
      inputMint: actors.mintIn.toBase58(),
      outputMint: actors.mintIn.toBase58(),
      amount: "1",
      slippageBps: 50,
    });
    const sameToken = same.find((issue) => issue.code === "SAME_TOKEN");
    assert.equal(sameToken?.params, undefined);
  });

  test("every issuer/mint custody warning names the mint and the authority in params", () => {
    const mint = actors.mintIn.toBase58();
    const delegate = actors.drainDelegate.toBase58();
    const risk: MintRisk = {
      freezeAuthority: delegate,
      permanentDelegate: delegate,
      transferHook: delegate,
      mintCloseAuthority: delegate,
      transferFee: true,
      nonTransferable: true,
      defaultFrozen: true,
      pausable: true,
    };
    const byCode = Object.fromEntries(mintRiskIssues(mint, risk).map((issue) => [issue.code, issue.params]));
    assert.deepEqual(byCode.ISSUER_PERMANENT_DELEGATE, { mint, delegate });
    assert.deepEqual(byCode.ISSUER_TRANSFER_HOOK, { mint, hook: delegate });
    assert.deepEqual(byCode.MINT_FREEZE_AUTHORITY, { mint, authority: delegate });
    assert.deepEqual(byCode.MINT_CLOSE_AUTHORITY, { mint, authority: delegate });
    assert.deepEqual(byCode.MINT_TRANSFER_FEE, { mint });
    assert.deepEqual(byCode.MINT_NON_TRANSFERABLE, { mint });
    assert.deepEqual(byCode.MINT_DEFAULT_FROZEN, { mint });
    assert.deepEqual(byCode.MINT_PAUSABLE, { mint });
  });

  test("POST_STATE_AUTHORITY_CHANGED lists the account and field in {accounts}", () => {
    const address = actors.ataIn.toBase58();
    const pre = parseTokenAccount(encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker }));
    const post = parseTokenAccount(
      encodeTokenAccount({ mint: actors.mintIn, owner: actors.taker, delegate: actors.drainDelegate }),
    );
    assert.ok(pre && post);
    const [issue] = postStateAuthorityIssues([{ address, pre, post }]);
    assert.equal(issue.code, "POST_STATE_AUTHORITY_CHANGED");
    assert.equal(issue.params?.accounts, `${address} (delegate)`);
  });

  test("UNKNOWN_PROGRAM hands over the full base58 program id, not a truncation", () => {
    const transaction = compile(
      [{ programId: actors.unknownProgram, keys: [], data: Buffer.alloc(0) }],
      actors.taker,
    );
    const issue = inspectSwapTransaction(transaction).find((candidate) => candidate.code === "UNKNOWN_PROGRAM");
    assert.equal(issue?.params?.program, actors.unknownProgram.toBase58());
  });
});
