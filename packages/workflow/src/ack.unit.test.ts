import assert from "node:assert/strict";
import test from "node:test";
import { resolveAckSelection, type AckRequest } from "./ack.js";

const dealerRequest: AckRequest = {
  id: "dealer",
  prompt: "选择门店",
  options: [
    { id: "dealer_a", label: "浦东门店" },
    { id: "dealer_b", label: "徐汇门店" },
  ],
};

test("resolveAckSelection matches numeric ordinal replies", () => {
  const selection = resolveAckSelection(dealerRequest, "第二个");

  assert.equal(selection?.index, 1);
  assert.equal(selection?.option.id, "dealer_b");
});

test("resolveAckSelection matches option labels in natural replies", () => {
  const selection = resolveAckSelection(dealerRequest, "就选徐汇门店吧");

  assert.equal(selection?.index, 1);
  assert.equal(selection?.option.id, "dealer_b");
});

test("resolveAckSelection accepts positive confirmation only for single-option requests", () => {
  const singleOptionRequest: AckRequest = {
    id: "slot",
    prompt: "确认时间",
    options: [{ id: "slot_1", label: "周五上午" }],
  };

  assert.equal(resolveAckSelection(singleOptionRequest, "确认")?.option.id, "slot_1");
  assert.equal(resolveAckSelection(dealerRequest, "确认"), undefined);
});

test("resolveAckSelection returns undefined for ambiguous empty replies", () => {
  assert.equal(resolveAckSelection(dealerRequest, "   "), undefined);
});
