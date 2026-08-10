import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFmpEarnings, parseBlsSeries, parseIcsEvents, parseTreasuryXml } from "../lib/market-context.js";

test("BLS series are converted to decision metrics", () => {
  const payload = {
    Results: { series: [
      { seriesID: "CUUR0000SA0", data: [
        { year: "2026", period: "M06", value: "320" },
        { year: "2025", period: "M06", value: "310" },
      ] },
      { seriesID: "LNS14000000", data: [{ year: "2026", period: "M07", value: "4.2" }] },
      { seriesID: "CES0000000001", data: [
        { year: "2026", period: "M07", value: "160200" },
        { year: "2026", period: "M06", value: "160050" },
      ] },
    ] },
  };
  const result = parseBlsSeries(payload);
  assert.equal(Math.round(result.cpiYoY * 100) / 100, 3.23);
  assert.equal(result.unemploymentRate, 4.2);
  assert.equal(result.payrollChange, 150);
});

test("Treasury XML returns descending 2Y and 10Y observations", () => {
  const xml = `<feed>
    <entry><content><m:properties><d:NEW_DATE>2026-08-07T00:00:00</d:NEW_DATE><d:BC_2YEAR>3.72</d:BC_2YEAR><d:BC_10YEAR>4.20</d:BC_10YEAR></m:properties></content></entry>
    <entry><content><m:properties><d:NEW_DATE>2026-08-06T00:00:00</d:NEW_DATE><d:BC_2YEAR>3.70</d:BC_2YEAR><d:BC_10YEAR>4.18</d:BC_10YEAR></m:properties></content></entry>
  </feed>`;
  const rows = parseTreasuryXml(xml);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].twoYear, 3.72);
  assert.equal(rows[0].tenYear, 4.2);
});

test("official BLS calendar events keep their real timestamp", () => {
  const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260812T123000Z\nSUMMARY:Consumer Price Index for July 2026\nEND:VEVENT\nEND:VCALENDAR`;
  const events = parseIcsEvents(ics, new Date("2026-08-10T00:00:00Z"));
  assert.equal(events.length, 1);
  assert.equal(events[0].category, "CPI");
  assert.equal(events[0].date, "2026-08-12T12:30:00.000Z");
});

test("FMP earnings separates next report from latest surprise", () => {
  const result = normalizeFmpEarnings([
    { symbol: "AAPL", date: "2026-07-30", epsActual: 1.7, epsEstimated: 1.6, revenueActual: 100, revenueEstimated: 98 },
    { symbol: "AAPL", date: "2026-10-29", epsActual: null, epsEstimated: 1.8, revenueEstimated: 110 },
  ], ["AAPL"], new Date("2026-08-10T00:00:00Z"));
  assert.equal(result.AAPL.next.epsEstimated, 1.8);
  assert.equal(Math.round(result.AAPL.latest.epsSurprise * 100) / 100, 6.25);
  assert.equal(Math.round(result.AAPL.latest.revenueSurprise * 100) / 100, 2.04);
});

