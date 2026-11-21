import {
  BLOCK_EXPIRY_SAFETY_MARGIN,
  BLOCKHASH_LIFETIME_BLOCKS,
  HIGH_SLIPPAGE_WARNING_BPS,
  MAX_SLIPPAGE_BPS,
  QUOTE_MAX_AGE_MS,
} from "./constants";
import { isValidMintFormat } from "./tokens";
import type { GuardIssue, OrderResponse, QuoteResponse, SwapRequest } from "./types";

export function validateSwapRequest(request: SwapRequest): GuardIssue[] {
  const issues: GuardIssue[] = [];

  if (!isValidMintFormat(request.inputMint) || !isValidMintFormat(request.outputMint)) {
    issues.push({
      level: "block",
      code: "INVALID_MINT",
      message: "Invalid token mint address. Check the contract and try again.",
    });
  }

  if (request.inputMint === request.outputMint) {
    issues.push({ level: "block", code: "SAME_TOKEN", message: "Choose different tokens for the swap." });
  }

  if (!/^[1-9]\d*$/.test(request.amount)) {
    issues.push({ level: "block", code: "INVALID_AMOUNT", message: "Amount must be a positive integer in the token's smallest units." });
  }

  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 1 || request.slippageBps > MAX_SLIPPAGE_BPS) {
    issues.push({
      level: "block",
      code: "INVALID_SLIPPAGE",
      message: `Slippage must be an integer between 1 and ${MAX_SLIPPAGE_BPS} bps.`,
      params: { max: String(MAX_SLIPPAGE_BPS) },
    });
  }

  return issues;
}

export function evaluateQuoteFreshness(
  quote: Pick<QuoteResponse, "fetchedAt" | "expireAt" | "lastValidBlockHeight">,
  context: { nowMs: number; currentBlockHeight?: number },
): GuardIssue[] {
  const issues: GuardIssue[] = [];

  if (context.nowMs - quote.fetchedAt > QUOTE_MAX_AGE_MS) {
    issues.push({ level: "block", code: "QUOTE_STALE", message: "Quote has gone stale. Refresh the price before signing." });
  }

  if (quote.expireAt !== undefined && quote.expireAt <= context.nowMs) {
    issues.push({ level: "block", code: "RFQ_EXPIRED", message: "The RFQ offer has expired. Refresh the price." });
  }

  if (quote.lastValidBlockHeight !== undefined && context.currentBlockHeight !== undefined) {
    const blocksLeft = quote.lastValidBlockHeight - context.currentBlockHeight;

    if (blocksLeft < -BLOCKHASH_LIFETIME_BLOCKS) {
      // Some public RPCs answer getBlockHeight with a slot-like number millions of blocks ahead of
      // the real height Jupiter measured against. Blocking on that would disable every swap, so an
      // incomparable scale is reported instead.
      issues.push({
        level: "warn",
        code: "BLOCK_HEIGHT_MISMATCH",
        message:
          "The RPC source returned a block height on a different scale, so blockhash freshness was not verified. If the blockhash has passed, the transaction simply never lands in a block — funds are not lost.",
      });
    } else if (blocksLeft <= BLOCK_EXPIRY_SAFETY_MARGIN) {
      issues.push({ level: "block", code: "BLOCKHASH_EXPIRING", message: "The transaction is close to blockhash expiry. Refresh the price." });
    }
  }

  return issues;
}

export function evaluateQuoteWarnings(quote: Pick<QuoteResponse, "slippageBps" | "router">): GuardIssue[] {
  const issues: GuardIssue[] = [];

  if (quote.slippageBps > HIGH_SLIPPAGE_WARNING_BPS) {
    issues.push({
      level: "warn",
      code: "HIGH_SLIPPAGE",
      message: "High slippage: the actual price may differ noticeably. For volatile tokens the risk is higher.",
    });
  }

  if (!["metis", "jupiterz", "dflow", "okx"].includes(quote.router.toLowerCase())) {
    issues.push({ level: "warn", code: "UNKNOWN_ROUTER", message: "Jupiter returned an unrecognized router. Check the details before signing." });
  }

  return issues;
}

export function assertOrderSignable(
  order: OrderResponse,
  context: { nowMs: number; currentBlockHeight?: number; feeConfigured: boolean },
): GuardIssue[] {
  const issues: GuardIssue[] = [];

  if (!order.transaction) {
    issues.push({
      level: "block",
      code: "EMPTY_TRANSACTION",
      message: mapJupiterBuildError(order.router, undefined),
    });
  }

  if (order.transactionVersion !== undefined && order.transactionVersion !== 0) {
    issues.push({ level: "block", code: "UNSUPPORTED_TX_VERSION", message: "Only transaction version 0 is supported for the wallet adapter MVP." });
  }

  if (!context.feeConfigured) {
    issues.push({ level: "block", code: "FEE_SETUP_REQUIRED", message: "The platform fee is not configured. Swap blocked." });
  }

  issues.push(...evaluateQuoteFreshness(order, context));
  issues.push(...evaluateQuoteWarnings(order));
  return issues;
}

export function mapJupiterBuildError(router: string, errorCode?: number): string {
  const normalizedRouter = router.toLowerCase();

  if (normalizedRouter === "jupiterz") {
    switch (errorCode) {
      case 1:
        return "Insufficient balance for the swap.";
      case 2:
        return "The recipient token account is missing. Try refreshing the quote or check your wallet.";
      case 3:
        return "The market maker could not build a quote. Try a different amount or wait.";
      default:
        return "JupiterZ did not build a transaction. Refresh the quote.";
    }
  }

  switch (errorCode) {
    case 1:
      return "Insufficient balance for the swap.";
    case 2:
      return "Not enough SOL for the network fee.";
    case 3:
      return "The amount is below the minimum for gasless execution.";
    default:
      return "The route returned a quote without a transaction. Refresh the price or change the parameters.";
  }
}

export function mapExecuteError(code: number): string {
  switch (code) {
    case -1:
      return "Jupiter no longer has an active requestId. Refresh the quote.";
    case -2:
    case -3:
      return "Jupiter rejected the transaction: it differs from the one issued for this quote. This is usually the wallet's own priority fee — Solflare cannot disable it, so try again or use another wallet. A rejected attempt costs no network fee.";
    case -1003:
      return "The transaction is not fully signed for this route.";
    case -1005:
      return "The blockhash passed before confirmation. Refresh the quote.";
    case -2003:
      return "The market maker's quote has passed. Refresh the quote.";
    case -1000:
    case -2000:
      return "The transaction did not land in a block. Check your balance and try refreshing the quote.";
    default:
      return "Execution failed. Check the transaction details and try again.";
  }
}
