import assert from "node:assert/strict";
import test from "node:test";
import { positiveInteger } from "../config.js";

test("research timeout accepts the configured 120-second value", () => {
  assert.equal(positiveInteger("120000", 25000, 600000), 120000);
});

test("positive integer configuration keeps defaults for invalid and out-of-range values", () => {
  assert.equal(positiveInteger(undefined, 25000, 600000), 25000);
  assert.equal(positiveInteger("0", 25000, 600000), 25000);
  assert.equal(positiveInteger("120000.5", 25000, 600000), 25000);
  assert.equal(positiveInteger("600001", 25000, 600000), 25000);
  assert.equal(positiveInteger("100001", 3), 3);
});
