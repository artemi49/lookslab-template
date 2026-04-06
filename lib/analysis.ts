// Scoring utility functions — self-contained TypeScript versions
// (The full analysis engines will be loaded via script tags when needed for the editor)

export function getScoreColor(score: number): string {
  if (score >= 8.0) return '#16A34A';
  if (score >= 6.5) return '#22C55E';
  if (score >= 5.0) return '#CA8A04';
  if (score >= 3.5) return '#EA580C';
  return '#DC2626';
}

function rawPercentileFromScore(score: number): number {
  if (score <= 0) return 99;
  const k = 1.1;
  const midpoint = 5.0;
  return 100.0 / (1.0 + Math.exp(k * (score - midpoint)));
}

export function calculatePercentile(score: number): number {
  return Math.max(1, Math.min(99, Math.round(rawPercentileFromScore(score))));
}

/** Allowed range for “Top n%” controls (step 0.1). */
export const TOP_PERCENT_MIN = 0.1;
export const TOP_PERCENT_MAX = 99;

export function clampTopPercentDecimal(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.round(Math.max(TOP_PERCENT_MIN, Math.min(TOP_PERCENT_MAX, n)) * 10) / 10;
}

/** Top % with 0.1 steps from combined score (rank / curve when following score). */
export function calculatePercentileTopDecimal(score: number): number {
  return clampTopPercentDecimal(rawPercentileFromScore(score));
}

/** Inverse of calculatePercentile: Top n% → score (0…10). */
export function percentileToScore(topPercent: number): number {
  const p = Math.max(TOP_PERCENT_MIN, Math.min(TOP_PERCENT_MAX, topPercent));
  const k = 1.1;
  const midpoint = 5.0;
  const score = midpoint + Math.log(100 / p - 1) / k;
  return Math.round(Math.max(0, Math.min(10, score)) * 10) / 10;
}

/**
 * Same calibration as `percentileToScore` but **not** rounded to 0.1 — use for curve marker
 * so the dot follows the Top-% slider smoothly in Custom mode.
 */
export function topPercentToCurveScore(topPercent: number): number {
  const p = clampTopPercentDecimal(topPercent);
  const k = 1.1;
  const midpoint = 5.0;
  const score = midpoint + Math.log(100 / p - 1) / k;
  return Math.max(0, Math.min(10, score));
}

export type CardLocale = 'en' | 'de';

/** Human-friendly "Top X%" / "Bottom X%" bucket label derived from raw percentile. */
export function getTopBottomLabel(topPercent: number, locale: CardLocale = 'en'): string {
  const p = Math.max(1, Math.min(99, Math.round(topPercent)));
  const bottom = locale === 'de' ? 'Untere' : 'Bottom';
  if (p <= 1) return 'Top 1%';
  if (p <= 3) return 'Top 3%';
  if (p <= 5) return 'Top 5%';
  if (p <= 10) return 'Top 10%';
  if (p <= 15) return 'Top 15%';
  if (p <= 25) return 'Top 25%';
  if (p <= 35) return 'Top 35%';
  if (p <= 50) return 'Top 50%';
  if (p <= 65) return `${bottom} 50%`;
  if (p <= 75) return `${bottom} 35%`;
  if (p <= 85) return `${bottom} 25%`;
  if (p <= 90) return `${bottom} 15%`;
  if (p <= 95) return `${bottom} 10%`;
  return `${bottom} 5%`;
}

/** Rank cell: bucket text for whole numbers, else “Top 10,3%” / “Top 10.3%”. */
export function formatRankTopPercent(topPercent: number, locale: CardLocale = "en"): string {
  const t = clampTopPercentDecimal(topPercent);
  if (Math.abs(t - Math.round(t)) < 1e-6) {
    return getTopBottomLabel(Math.round(t), locale);
  }
  if (locale === "de") {
    return `Top ${t.toFixed(1).replace(".", ",")}%`;
  }
  return `Top ${t.toFixed(1)}%`;
}

export function getPercentileLabel(percentile: number): string {
  return getPercentileLabelLocalized(percentile, 'en');
}

/** Tier label for share card (English or German). */
export function getPercentileLabelLocalized(percentile: number, locale: CardLocale): string {
  if (locale === 'de') {
    if (percentile <= 5) return 'Elite';
    if (percentile <= 10) return 'Hervorragend';
    if (percentile <= 20) return 'Sehr gut';
    if (percentile <= 35) return 'Gut';
    if (percentile <= 50) return 'Mittel';
    if (percentile <= 65) return 'Ausbaufähig';
    return 'Fokus nötig';
  }
  if (percentile <= 5) return 'Exceptional';
  if (percentile <= 10) return 'Excellent';
  if (percentile <= 20) return 'Very Good';
  if (percentile <= 35) return 'Good';
  if (percentile <= 50) return 'Moderate';
  if (percentile <= 65) return 'Developing';
  return 'Needs Focus';
}

export function getScoreLabel(score: number): string {
  if (score >= 8.5) return 'Ideal';
  if (score >= 7.0) return 'Excellent';
  if (score >= 5.5) return 'Good';
  if (score >= 4.0) return 'Moderate';
  if (score >= 2.5) return 'Developing';
  return 'Needs Focus';
}

export function calculateCombinedScore(front: number | null, side: number | null): number {
  if (front !== null && side !== null) return front * 0.61 + side * 0.39;
  return front ?? side ?? 0;
}

/* —— Score-based bell curve: N(μ=5, σ=1.5) on score axis 0…10 —— */

const SHARE_CURVE_WIDTH = 200;
const SHARE_CURVE_BASELINE = 68;
const SHARE_CURVE_PEAK_AMP = 56;
const SHARE_CURVE_STEPS = 120;

const SCORE_MEAN = 5;
const SCORE_SD = 1.5;
const SCORE_MAX = 10;

const SQRT2PI = Math.sqrt(2 * Math.PI);

/** φ(z) — standard normal PDF. */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT2PI;
}

/** Pixel x for a given harmony score (0…10) on the share-card chart. */
export function scoreBasedMarkerX(score: number, width = SHARE_CURVE_WIDTH): number {
  return (Math.max(0, Math.min(SCORE_MAX, score)) / SCORE_MAX) * width;
}

/** Pixel y on the bell curve at pixel x. */
export function scoreBasedCurveYAtX(
  x: number,
  opts?: { width?: number; baseline?: number; peakAmp?: number; scoreSd?: number },
): number {
  const w = opts?.width ?? SHARE_CURVE_WIDTH;
  const baseline = opts?.baseline ?? SHARE_CURVE_BASELINE;
  const peakAmp = opts?.peakAmp ?? SHARE_CURVE_PEAK_AMP;
  const sd = opts?.scoreSd ?? SCORE_SD;
  const score = (Math.max(0, Math.min(w, x)) / w) * SCORE_MAX;
  const z = (score - SCORE_MEAN) / sd;
  return baseline - peakAmp * (normalPdf(z) / normalPdf(0));
}

export type ScoreBasedCurvePaths = { strokeD: string; areaD: string };

/** SVG polyline paths for the score-based N(5,1.5²) distribution. */
export function scoreBasedCurvePaths(
  opts?: { width?: number; baseline?: number; peakAmp?: number; steps?: number; scoreSd?: number },
): ScoreBasedCurvePaths {
  const w = opts?.width ?? SHARE_CURVE_WIDTH;
  const baseline = opts?.baseline ?? SHARE_CURVE_BASELINE;
  const peakAmp = opts?.peakAmp ?? SHARE_CURVE_PEAK_AMP;
  const steps = opts?.steps ?? SHARE_CURVE_STEPS;
  const sd = opts?.scoreSd ?? SCORE_SD;
  const pdf0 = normalPdf(0);
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w;
    const score = (x / w) * SCORE_MAX;
    const z = (score - SCORE_MEAN) / sd;
    const y = baseline - peakAmp * (normalPdf(z) / pdf0);
    parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(3)}`);
  }
  const strokeD = parts.join("");
  const areaD = `${strokeD}L${w},${baseline}L0,${baseline}Z`;
  return { strokeD, areaD };
}

/** Section boundaries with percentage of population for the score distribution chart. */
export const SCORE_SECTIONS = [
  { from: 0, to: 2, pct: "2.5%" },
  { from: 2, to: 3, pct: "7%" },
  { from: 3, to: 4, pct: "15%" },
  { from: 4, to: 5, pct: "25%" },
  { from: 5, to: 6, pct: "25%" },
  { from: 6, to: 7, pct: "15%" },
  { from: 7, to: 8, pct: "7%" },
  { from: 8, to: 10, pct: "2.5%" },
] as const;
