// The billing words and the price shown before the signature prompt (feature brief #3 / #4). Pure functions, no DOM,
// no chain. Run: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { jobPriceWei, protocolCutWei } from "@/lib/job-payment";
import { parseJobRequest } from "@/lib/protocol";
import { chargeWords, quoteJob } from "./paid-jobs";

const WEI_PER_UNIT = 500_000_000n;

describe("the price shown before signing is the price the scheduler checks", () => {
  const requests = {
    image: { kind: "image", params: { model: "sd15", prompt: "a lighthouse at dusk", negative: "", width: 512, height: 384, steps: 30, guidance: 7.5 } },
    text: { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "Summarise the rules of chess.", system: "", maxTokens: 256 } },
  };
  for (const [kind, request] of Object.entries(requests)) {
    test(`${kind} job: quoteJob equals jobPriceWei of the parsed request`, () => {
      const q = quoteJob(request, WEI_PER_UNIT);
      assert.ok(q);
      assert.equal(q.draft, false);
      assert.equal(q.wei, jobPriceWei(parseJobRequest(request), WEI_PER_UNIT));
      assert.ok(q.wei > 0n);
    });
  }

  test("the per-job protocol cut is price x 500 / 10 000, rounded down", () => {
    assert.equal(protocolCutWei(10_000n), 500n);
    assert.equal(protocolCutWei(19_999n), 999n);
    assert.equal(protocolCutWei(19n), 0n);
  });
});

describe("chargeWords: the status words of a paid job", () => {
  test("pending is held; charged names its epoch", () => {
    assert.equal(chargeWords({ chargeStatus: "pending", verdict: null, chargedEpoch: null }).label, "Held");
    assert.match(chargeWords({ chargeStatus: "pending", verdict: "agreed", chargedEpoch: null }).text, /charged when the epoch closes/);
    assert.equal(chargeWords({ chargeStatus: "charged", verdict: "agreed", chargedEpoch: 7 }).label, "Charged in epoch 7");
  });

  test("released says not charged, with the reason; unpaid says the balance was withdrawn", () => {
    assert.equal(chargeWords({ chargeStatus: "released", verdict: "disagreed", chargedEpoch: null }).text, "Not charged: the two results did not match.");
    assert.match(chargeWords({ chargeStatus: "released", verdict: "expired", chargedEpoch: null }).text, /^Not charged: .*expired/);
    assert.match(chargeWords({ chargeStatus: "released", verdict: "rejected", chargedEpoch: null }).text, /^Not charged: .*safety check/);
    assert.equal(chargeWords({ chargeStatus: "unpaid", verdict: "agreed", chargedEpoch: null }).text, "Matched, but the balance was withdrawn before the charge.");
  });

  test("never 'refund' and never 'instant'", () => {
    for (const chargeStatus of ["pending", "charged", "released", "unpaid"] as const) {
      for (const verdict of [null, "agreed", "disagreed", "expired", "rejected"] as const) {
        const w = chargeWords({ chargeStatus, verdict, chargedEpoch: 3 });
        assert.doesNotMatch(`${w.label} ${w.text}`, /refund|instant/i);
      }
    }
  });
});
