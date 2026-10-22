// Rough price forecast from a price history: [[isoDate, price], ...] oldest first.
//
// Weekly medians of log price; a robust Theil–Sen trend over the past year
// blended 50/50 with the past ~10 weeks; the trend is damped (fades with a
// ~120-day time constant) instead of compounding forever; the range is ±1.28σ
// (about 8 in 10) where σ is the robust week-to-week swing scaled by √time,
// widened when the long and short trends disagree.

export const HORIZONS = [["1 month", 30], ["3 months", 91], ["6 months", 182], ["1 year", 365]];
const TAU = 120;
const DAY = 864e5;
const toDay = d => Date.parse(d + "T00:00:00Z") / DAY;

function median(v) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function theilSen(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++)
      if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  if (!slopes.length) return 0;
  slopes.sort((a, b) => a - b);
  return slopes[Math.floor(slopes.length / 2)];
}

function weekly(series) {
  const last = toDay(series[series.length - 1][0]);
  const buckets = new Map();
  for (const [d, p] of series) {
    const age = last - toDay(d), wk = Math.floor(age / 7);
    if (!buckets.has(wk)) buckets.set(wk, []);
    buckets.get(wk).push([age, Math.log(p)]);
  }
  return [...buckets.keys()].sort((a, b) => b - a).map(wk => {
    const b = buckets.get(wk);
    return [-median(b.map(x => x[0])), median(b.map(x => x[1]))];
  });
}

export function forecast(series, horizons = HORIZONS) {
  series = series.filter(([, p]) => p > 0);
  if (series.length < 3) return {ok: false, reason: "Not enough price history yet."};
  const span = Math.round(toDay(series[series.length - 1][0]) - toDay(series[0][0]));
  if (span < 21) return {ok: false, reason: `Only ${span} days of history; needs about 3 weeks.`};
  const pts = weekly(series).filter(p => p[0] >= -365);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const slopeLong = theilSen(xs, ys);
  const recent = pts.filter(p => p[0] >= -70);
  const slopeShort = recent.length >= 4 ? theilSen(recent.map(p => p[0]), recent.map(p => p[1])) : slopeLong;
  const slope = .5 * slopeLong + .5 * slopeShort;

  const rets = [];
  for (let i = 1; i < pts.length; i++) {
    const gap = Math.max(1, (pts[i][0] - pts[i - 1][0]) / 7);
    rets.push((pts[i][1] - pts[i - 1][1]) / Math.sqrt(gap));
  }
  let sigma = .06;
  if (rets.length >= 3) { const m = median(rets); sigma = 1.4826 * median(rets.map(r => Math.abs(r - m))); }
  sigma = Math.min(.25, Math.max(.015, sigma));

  const now = series[series.length - 1][1];
  const anchor = .7 * Math.log(now) + .3 * median(ys.slice(-3));
  const disagree = Math.abs(slopeLong - slopeShort);
  const points = horizons.map(([label, h]) => {
    const g = TAU * (1 - Math.exp(-h / TAU));
    const drift = Math.max(-.9, Math.min(.9, slope * g));
    const sd = sigma * Math.sqrt(h / 7) + .5 * disagree * g;
    const mid = Math.exp(anchor + drift);
    return {label, days: h, price: mid, low: Math.exp(anchor + drift - 1.28 * sd), high: Math.exp(anchor + drift + 1.28 * sd), change: mid / now - 1};
  });
  const spread = points.length > 1 ? (points[1].high - points[1].low) / now : 1;
  const confidence = pts.length >= 26 && spread < .35 ? "medium" : pts.length >= 8 && spread < .8 ? "low" : "very low";
  const sd90 = sigma * Math.sqrt(91 / 7), move90 = slope * 91;
  const signal = move90 > .6 * sd90 && move90 > .03 ? "rising" : move90 < -.6 * sd90 && move90 < -.03 ? "falling" : "steady";
  return {ok: true, now, points, signal, confidence, trendPerYear: Math.exp(slope * 365) - 1,
          weeklySwing: sigma, historyDays: span, historyWeeks: pts.length};
}

// Hide the last ~30 days, forecast them, and compare with what happened and
// with just guessing "no change".
export function backtest(series, horizon = 30) {
  if (series.length < 4) return null;
  const last = toDay(series[series.length - 1][0]);
  const past = series.filter(([d]) => toDay(d) <= last - horizon);
  if (past.length < 3) return null;
  const gap = Math.round(last - toDay(past[past.length - 1][0]));
  if (gap > horizon + 10) return null;
  const f = forecast(past, [["check", gap]]);
  if (!f.ok) return null;
  const p = f.points[0], actual = series[series.length - 1][1], base = past[past.length - 1][1];
  return {from: past[past.length - 1][0], days: gap, predicted: p.price, actual,
          error: Math.abs(p.price - actual) / actual, naiveError: Math.abs(base - actual) / actual,
          inRange: p.low <= actual && actual <= p.high};
}

export function changeOver(series, days) {
  if (series.length < 2) return null;
  const last = toDay(series[series.length - 1][0]), target = last - days, tol = Math.max(3, Math.floor(days / 3));
  let best = null;
  for (const [d, p] of series.slice(0, -1)) {
    const diff = Math.abs(toDay(d) - target);
    if (diff <= tol && (!best || diff < best[0])) best = [diff, p];
  }
  return best ? series[series.length - 1][1] / best[1] - 1 : null;
}
