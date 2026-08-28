import assert from "node:assert/strict";
import test from "node:test";

import {
  bookedSetsEqual,
  cleanBooked,
  isIsoDate,
  parseBookedInput
} from "../netlify/functions/_shared/availability.js";

test("ISO date validation rejects impossible calendar dates", () => {
  assert.equal(isIsoDate("2026-02-28"), true);
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate("not-a-date"), false);
});

test("cleanBooked sorts and deduplicates valid dates", () => {
  assert.deepEqual(
    cleanBooked(["2026-10-02", "bad", "2026-09-30", "2026-10-02"]),
    ["2026-09-30", "2026-10-02"]
  );
});

test("parseBookedInput fails closed when any submitted date is invalid", () => {
  assert.deepEqual(parseBookedInput([]), []);
  assert.deepEqual(parseBookedInput(["2026-09-30", "2026-09-30"]), ["2026-09-30"]);
  assert.equal(parseBookedInput(["2026-09-30", "invalid"]), null);
  assert.equal(parseBookedInput(null), null);
});

test("bookedSetsEqual compares canonical snapshots", () => {
  assert.equal(bookedSetsEqual(["2026-10-02", "2026-09-30"], ["2026-09-30", "2026-10-02"]), true);
  assert.equal(bookedSetsEqual(["2026-09-30"], ["2026-10-02"]), false);
});
