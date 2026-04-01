"use client";

import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/cn";
import {
  calculateCombinedScore,
  calculatePercentile,
  getPercentileLabelLocalized,
  getTopBottomLabel,
  percentileToScore,
  scoreBasedCurveYAtX,
  scoreBasedCurvePaths,
  scoreBasedMarkerX,
  SCORE_SECTIONS,
  type CardLocale,
} from "@/lib/analysis";
import { preloadShareCardFonts, type MetricRow } from "@/lib/shareCardCanvas";
import { toBlob } from "html-to-image";
import html2canvas from "html2canvas";
import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useId } from "react";

type Mode = "harmony" | "metrics";

const RATIO_LIBRARY = [
  "Eye spacing",
  "Canthal tilt",
  "Facial thirds",
  "Jaw width",
  "Philtrum length",
  "Nasal ratio",
  "Lower third",
  "Upper third",
  "Bigonial width",
  "Midface ratio",
  "Interpupillary distance",
  "Lip proportion",
] as const;

/** Card chrome base tone (preview). PNG export uses no canvas fill so rounded corners stay transparent. */
const SHARE_CARD_EXPORT_BG = "#eef2f7";

/** 1×1 transparent PNG — html-to-image uses this when an inlined resource fails instead of aborting. */
const EXPORT_IMAGE_PLACEHOLDER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TIKTOK_EXPORT_WIDTH = 1440;
const TIKTOK_EXPORT_HEIGHT = 2560;

/** Safe `url("...")` for CSS (blob/data URLs). html2canvas rasterizes `background-size: cover` more faithfully than `<img object-fit>`. */
function cssBackgroundUrl(href: string): string {
  return `url(${JSON.stringify(href)})`;
}

const defaultMetrics: MetricRow[] = [
  { label: "Harmony", value: "7.5", percent: 75, tone: "blue" },
  { label: "Structure", value: "Good", percent: 72, tone: "green" },
  { label: "Eyes", value: "6.8", percent: 68, tone: "blue" },
  { label: "Midface", value: "6.2", percent: 62, tone: "amber" },
  { label: "Lower third", value: "7.1", percent: 71, tone: "green" },
];

const METRIC_PRESETS: Array<
  MetricRow & {
    key: string;
  }
> = [
  { key: "harmony", label: "Harmony", value: "7.5", percent: 75, tone: "blue" },
  { key: "structure", label: "Structure", value: "Good", percent: 72, tone: "green" },
  { key: "eyes", label: "Eyes", value: "6.8", percent: 68, tone: "blue" },
  { key: "midface", label: "Midface", value: "6.2", percent: 62, tone: "amber" },
  { key: "lower-third", label: "Lower third", value: "7.1", percent: 71, tone: "green" },
  { key: "upper-third", label: "Upper third", value: "6.5", percent: 65, tone: "amber" },
  { key: "nose", label: "Nose", value: "6.7", percent: 67, tone: "blue" },
  { key: "jawline", label: "Jawline", value: "6.9", percent: 69, tone: "green" },
  { key: "lips", label: "Lips", value: "6.4", percent: 64, tone: "amber" },
  { key: "symmetry", label: "Symmetry", value: "7.0", percent: 70, tone: "green" },
];

function toneFromPercent(percent: number): NonNullable<MetricRow["tone"]> {
  if (percent >= 70) return "green";
  if (percent >= 65) return "blue";
  if (percent >= 40) return "amber";
  return "rose";
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = url;
  });
}

function downloadPngBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}

async function normalizeToTikTokSize(blob: Blob): Promise<Blob | null> {
  const srcUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImageFromUrl(srcUrl);
    const canvas = document.createElement("canvas");
    canvas.width = TIKTOK_EXPORT_WIDTH;
    canvas.height = TIKTOK_EXPORT_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;

    const targetRatio = TIKTOK_EXPORT_WIDTH / TIKTOK_EXPORT_HEIGHT;
    const srcRatio = img.width / img.height;
    let drawW = TIKTOK_EXPORT_WIDTH;
    let drawH = TIKTOK_EXPORT_HEIGHT;
    let drawX = 0;
    let drawY = 0;

    // Cover-fit to guarantee exact 9:16 output even if the source card bounds are slightly off.
    if (srcRatio > targetRatio) {
      drawH = TIKTOK_EXPORT_HEIGHT;
      drawW = drawH * srcRatio;
      drawX = (TIKTOK_EXPORT_WIDTH - drawW) / 2;
    } else {
      drawW = TIKTOK_EXPORT_WIDTH;
      drawH = drawW / srcRatio;
      drawY = (TIKTOK_EXPORT_HEIGHT - drawH) / 2;
    }

    ctx.drawImage(img, drawX, drawY, drawW, drawH);
    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png", 1);
    });
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}

/**
 * Primary raster path for Next.js / Turbopack: avoids html-to-image reading `document.styleSheets[].cssRules`
 * (opaque cross-origin sheets → SecurityError). html-to-image is only used as fallback with `skipFonts: true`.
 *
 * Do not pass html2canvas `width`/`height` — those must match its internal `parseBounds` size. Overriding them
 * (especially with `scrollHeight`) stretches type relative to the preview.
 */
async function cardToPngBlobHtml2Canvas(el: HTMLElement, targetWidth: number): Promise<Blob | null> {
  const rect = el.getBoundingClientRect();
  const cssW = Math.max(1, rect.width);
  const cssH = Math.max(1, rect.height);
  const scale = targetWidth / cssW;

  const canvas = await html2canvas(el, {
    scale,
    width: cssW,
    height: cssH,
    windowWidth: cssW,
    windowHeight: cssH,
    useCORS: true,
    allowTaint: false,
    logging: false,
    backgroundColor: null,
    foreignObjectRendering: false,
    onclone(clonedDoc, clonedEl) {
      clonedEl.style.width = `${cssW}px`;
      clonedEl.style.height = `${cssH}px`;
      clonedEl.style.maxWidth = "none";
      clonedEl.style.aspectRatio = "auto";
      clonedEl.style.margin = "0";

      const win = clonedDoc.defaultView;
      if (!win) return;
      clonedDoc.body.querySelectorAll("*").forEach((node) => {
        if (!(node instanceof win.HTMLElement)) return;

        node.style.setProperty("-webkit-font-smoothing", "antialiased");
        node.style.setProperty("-moz-osx-font-smoothing", "grayscale");
        node.style.setProperty("text-rendering", "geometricPrecision");

        const cs = win.getComputedStyle(node);
        if (
          cs.backdropFilter !== "none" ||
          cs.getPropertyValue("-webkit-backdrop-filter") !== "none"
        ) {
          node.style.setProperty("backdrop-filter", "none");
          node.style.setProperty("-webkit-backdrop-filter", "none");
        }
      });
    },
  });
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png", 1);
  });
}

export default function ImageCreateScreen() {
  const setScreen = useAppStore((s) => s.setScreen);

  const [mode, setMode] = useState<Mode>("harmony");

  const [frontPreview, setFrontPreview] = useState<string | null>(null);
  const [sidePreview, setSidePreview] = useState<string | null>(null);
  const [portraitPreview, setPortraitPreview] = useState<string | null>(null);

  const [frontScore, setFrontScore] = useState(8.2);
  const [sideScore, setSideScore] = useState(7.9);
  const [combinedScore, setCombinedScore] = useState(8.05);
  const [autoCombined, setAutoCombined] = useState(true);

  const [cardLang, setCardLang] = useState<CardLocale>("en");
  const [percentileLabel, setPercentileLabel] = useState(() =>
    getPercentileLabelLocalized(calculatePercentile(8.05), "en")
  );
  /** When set, drives population curve + “Top n%” on the card; cleared when scores / auto mode change. */
  const [populationTopOverride, setPopulationTopOverride] = useState<number | null>(null);
  const populationTopPercent = useMemo(() => {
    const fromScore = calculatePercentile(combinedScore);
    const v = populationTopOverride ?? fromScore;
    return Math.max(1, Math.min(99, Math.round(v)));
  }, [combinedScore, populationTopOverride]);

  const rarityLine = useMemo(() => {
    const top = Math.max(1, Math.min(99, populationTopPercent));
    if (top <= 50) {
      const n = Math.max(2, Math.round(100 / top));
      return cardLang === "de" ? `1 von ${n}` : `1 in ${n}`;
    }
    return "";
  }, [populationTopPercent, cardLang]);

  const populationSliderUiValue = 100 - populationTopPercent;

  useEffect(() => {
    setPopulationTopOverride(null);
  }, [frontScore, sideScore, sidePreview, autoCombined]);

  const [title, setTitle] = useState("Your profile");
  const [subtitle, setSubtitle] = useState("Harmony map");
  const [metricRows, setMetricRows] = useState<MetricRow[]>(defaultMetrics);
  const [selectedRatios, setSelectedRatios] = useState<string[]>([
    "Eye spacing",
    "Canthal tilt",
    "Facial thirds",
    "Jaw width",
    "Nasal ratio",
  ]);
  const [ratioPicker, setRatioPicker] = useState<string>(RATIO_LIBRARY[0]);

  const frontImgRef = useRef<HTMLImageElement | null>(null);
  const sideImgRef = useRef<HTMLImageElement | null>(null);
  const portraitImgRef = useRef<HTMLImageElement | null>(null);
  const exportCardRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoCombined) return;
    const c = calculateCombinedScore(frontScore, sidePreview ? sideScore : null);
    setCombinedScore(c);
  }, [autoCombined, frontScore, sideScore, sidePreview, cardLang]);

  useEffect(() => {
    const p = calculatePercentile(combinedScore);
    setPercentileLabel(getPercentileLabelLocalized(p, cardLang));
  }, [combinedScore, cardLang]);

  const onFile = (
    file: File | null,
    setPreview: (u: string | null) => void,
    ref: React.MutableRefObject<HTMLImageElement | null>
  ) => {
    ref.current = null;
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    loadImageFromUrl(url).then((img) => {
      ref.current = img;
    }).catch(() => {});
  };

  const clearFile = (
    setPreview: (u: string | null) => void,
    ref: React.MutableRefObject<HTMLImageElement | null>
  ) => {
    ref.current = null;
    setPreview(null);
  };

  useEffect(() => {
    if (!frontPreview) {
      frontImgRef.current = null;
      return;
    }
    loadImageFromUrl(frontPreview).then((img) => {
      frontImgRef.current = img;
    }).catch(() => {});
  }, [frontPreview]);

  useEffect(() => {
    if (!sidePreview) {
      sideImgRef.current = null;
      return;
    }
    loadImageFromUrl(sidePreview).then((img) => {
      sideImgRef.current = img;
    }).catch(() => {});
  }, [sidePreview]);

  useEffect(() => {
    if (!portraitPreview) {
      portraitImgRef.current = null;
      return;
    }
    loadImageFromUrl(portraitPreview).then((img) => {
      portraitImgRef.current = img;
    }).catch(() => {});
  }, [portraitPreview]);

  const importFromScan = useCallback(() => {
    const s = useAppStore.getState();
    if (s.frontImageUrl) {
      setFrontPreview(s.frontImageUrl);
      loadImageFromUrl(s.frontImageUrl).then((img) => {
        frontImgRef.current = img;
      }).catch(() => {});
    }
    if (s.sideImageUrl || s.sideFlippedUrl) {
      const u = s.sideFlippedUrl || s.sideImageUrl!;
      setSidePreview(u);
      loadImageFromUrl(u).then((img) => {
        sideImgRef.current = img;
      }).catch(() => {});
    }
    if (s.frontResult) setFrontScore(s.frontResult.harmonyScore);
    if (s.sideResult) setSideScore(s.sideResult.harmonyScore);
    const comb = calculateCombinedScore(
      s.frontResult?.harmonyScore ?? null,
      s.sideResult?.harmonyScore ?? null
    );
    setCombinedScore(comb);
    const p = calculatePercentile(comb);
    setPercentileLabel(getPercentileLabelLocalized(p, cardLang));
    setPopulationTopOverride(null);
    setPortraitPreview(s.frontImageUrl);
    if (s.frontImageUrl) {
      loadImageFromUrl(s.frontImageUrl).then((img) => {
        portraitImgRef.current = img;
      }).catch(() => {});
    }
  }, [cardLang]);

  const exportPng = async () => {
    const el = exportCardRef.current;
    const scrollEl = previewScrollRef.current;
    if (!el) return;
    if (scrollEl) scrollEl.scrollTop = 0;

    const prevOverflow = scrollEl?.style.overflow;
    const prevMaxH = scrollEl?.style.maxHeight;
    if (scrollEl) {
      scrollEl.style.overflow = "visible";
      scrollEl.style.maxHeight = "none";
    }

    await preloadShareCardFonts();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    await new Promise<void>((r) => setTimeout(r, 50));

    // `mx-auto` resolves to large L/R margins in a wide column; the clone is rasterized
    // inside a foreignObject only as wide as the card — keep those margins at 0 on the
    // live node so the clone’s computed styles match export (avoids left gap / clip).
    const prevCardMarginLeft = el.style.marginLeft;
    const prevCardMarginRight = el.style.marginRight;
    el.style.marginLeft = "0";
    el.style.marginRight = "0";
    void el.offsetWidth;

    // Match the visible painted box (same aspect ratio as preview). `scrollHeight` ≫ `offsetHeight` breaks
    // html-to-image / forced html2canvas rects and stretches typography.
    const br = el.getBoundingClientRect();
    const w = Math.max(2, Math.round(br.width));
    let h = Math.max(2, Math.round(br.height));
    h = Math.min(h, 8192);
    if (w < 2 || h < 2) {
      el.style.marginLeft = prevCardMarginLeft;
      el.style.marginRight = prevCardMarginRight;
      if (scrollEl) {
        scrollEl.style.overflow = prevOverflow ?? "";
        scrollEl.style.maxHeight = prevMaxH ?? "";
      }
      return;
    }
    const targetW = TIKTOK_EXPORT_WIDTH;
    const pixelRatio = targetW / w;

    // IMPORTANT: `cacheBust: true` appends `?timestamp` to every URL. That breaks `blob:` preview URLs
    // from createObjectURL — fetch fails and the whole capture aborts. Never bust cache for export.
    const commonOpts = {
      cacheBust: false as const,
      imagePlaceholder: EXPORT_IMAGE_PLACEHOLDER,
    };

    // Never use skipFonts: false here — it scans all stylesheets for @font-face and hits opaque CSSOM (SecurityError)
    // under Next/Turbopack and many dev setups. Fonts are already loaded via preloadShareCardFonts + computed styles.
    const exportAttempts: Array<{ pixelRatio: number; useMeasuredSize?: boolean }> = [
      { pixelRatio },
      { pixelRatio: Math.min(pixelRatio, 2) },
      { pixelRatio: 1 },
      { pixelRatio: 1, useMeasuredSize: true },
    ];

    try {
      let blob: Blob | null = null;
      let lastErr: unknown;

      try {
        blob = await cardToPngBlobHtml2Canvas(el, targetW);
      } catch (h2cErr) {
        lastErr = h2cErr;
        console.warn("html2canvas export failed, trying html-to-image:", h2cErr);
      }

      if (!blob) {
        for (const attempt of exportAttempts) {
          try {
            blob = await toBlob(el, {
              ...commonOpts,
              skipFonts: true,
              pixelRatio: attempt.pixelRatio,
              ...(attempt.useMeasuredSize ? {} : { width: w, height: h }),
            });
            if (blob) break;
          } catch (err) {
            lastErr = err;
          }
        }
      }

      if (!blob) {
        console.error("PNG export failed after html2canvas + html-to-image:", lastErr);
        return;
      }
      const finalBlob = (await normalizeToTikTokSize(blob)) ?? blob;
      downloadPngBlob(
        finalBlob,
        mode === "harmony" ? "lookslab-harmony-card.png" : "lookslab-metrics-card.png"
      );
    } catch (e) {
      console.error("PNG export failed:", e);
    } finally {
      el.style.marginLeft = prevCardMarginLeft;
      el.style.marginRight = prevCardMarginRight;
      if (scrollEl) {
        scrollEl.style.overflow = prevOverflow ?? "";
        scrollEl.style.maxHeight = prevMaxH ?? "";
      }
    }
  };

  const combinedDisplay = useMemo(() => combinedScore.toFixed(1), [combinedScore]);

  const updateMetric = (i: number, patch: Partial<MetricRow>) => {
    setMetricRows((prev) => {
      const next = [...prev];
      const merged = { ...next[i], ...patch };
      const percent = Math.max(0, Math.min(100, Number(merged.percent) || 0));
      merged.percent = percent;
      merged.tone = toneFromPercent(percent);
      next[i] = merged;
      return next;
    });
  };

  const applyMetricPreset = (i: number, presetKey: string) => {
    const preset = METRIC_PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    updateMetric(i, {
      label: preset.label,
      value: preset.value,
      percent: preset.percent,
      tone: preset.tone,
    });
  };

  return (
    <div className="min-h-full app-surface p-3 sm:p-5 lg:p-8 pb-10 sm:pb-14 lg:pb-16">
      <div className="max-w-[1400px] mx-auto">
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end justify-between gap-4 mb-6 sm:mb-8">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.22em] text-[#5B8FD9] uppercase mb-1">Studio export</p>
            <h1 className="text-3xl sm:text-4xl text-slate-900 font-normal leading-tight" style={{ fontFamily: "var(--font-serif)" }}>
              Image Create
            </h1>
            <p className="text-sm text-slate-500 mt-2 max-w-xl">
              LooksLab wordmark and LooksLab.de on every export — same fonts as the app (Instrument Serif + Plus Jakarta Sans).
            </p>
          </div>
          <div className="flex flex-col sm:flex-row flex-wrap gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={importFromScan}
              className="app-btn-secondary px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer w-full sm:w-auto"
            >
              Import from current scan
            </button>
            <button
              type="button"
              onClick={exportPng}
              className="app-btn-primary px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer w-full sm:w-auto"
            >
              Download PNG
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="flex gap-2">
            {(["harmony", "metrics"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "px-4 py-2 rounded-xl text-sm font-semibold border transition-all cursor-pointer",
                  mode === m
                    ? "bg-[#BFDEFE]/80 border-[#8CB3F2] text-slate-900 shadow-[0_6px_18px_rgba(140,179,242,0.35)]"
                    : "bg-white/70 border-black/10 text-slate-600 hover:bg-white"
                )}
              >
                {m === "harmony" ? "Harmony card" : "Metrics grid"}
              </button>
            ))}
          </div>
          <div
            className="flex rounded-xl border border-black/10 p-0.5 bg-white/75"
            role="group"
            aria-label="Card language"
          >
            {(["en", "de"] as const).map((lng) => (
              <button
                key={lng}
                type="button"
                onClick={() => setCardLang(lng)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide min-w-[44px]",
                  cardLang === lng
                    ? "bg-[#8CB3F2]/40 text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                )}
              >
                {lng}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,420px)_1fr] gap-6 sm:gap-8 items-start">
          <div className="space-y-5">
            {mode === "harmony" ? (
              <>
                <div className="app-card-strong p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Photos</div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2">Front (required for best result)</label>
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="front-file-input"
                        className="inline-flex items-center justify-center h-10 px-4 rounded-xl border border-black/10 bg-white/85 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-white transition"
                      >
                        Datei auswählen
                      </label>
                      {frontPreview && (
                        <button
                          type="button"
                          onClick={() => clearFile(setFrontPreview, frontImgRef)}
                          className="inline-flex items-center justify-center h-10 px-3 rounded-xl border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-600 hover:bg-rose-100 transition"
                        >
                          Entfernen
                        </button>
                      )}
                    </div>
                    <input
                      id="front-file-input"
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => onFile(e.target.files?.[0] ?? null, setFrontPreview, frontImgRef)}
                    />
                    <p className="text-[11px] text-slate-500 mt-1.5">{frontPreview ? "Datei ausgewählt" : "Keine Datei ausgewählt"}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2">Side (optional)</label>
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="side-file-input"
                        className="inline-flex items-center justify-center h-10 px-4 rounded-xl border border-black/10 bg-white/85 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-white transition"
                      >
                        Datei auswählen
                      </label>
                      {sidePreview && (
                        <button
                          type="button"
                          onClick={() => clearFile(setSidePreview, sideImgRef)}
                          className="inline-flex items-center justify-center h-10 px-3 rounded-xl border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-600 hover:bg-rose-100 transition"
                        >
                          Entfernen
                        </button>
                      )}
                    </div>
                    <input
                      id="side-file-input"
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => onFile(e.target.files?.[0] ?? null, setSidePreview, sideImgRef)}
                    />
                    <p className="text-[11px] text-slate-500 mt-1.5">{sidePreview ? "Datei ausgewählt" : "Keine Datei ausgewählt"}</p>
                  </div>
                </div>
                <div className="app-card-strong p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Scores</div>
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoCombined}
                      onChange={(e) => setAutoCombined(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    Auto combined + percentile from scores
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Front /10" type="number" step="0.01" value={frontScore} onChange={(v) => setFrontScore(v)} />
                    <Field label="Side /10" type="number" step="0.01" value={sideScore} onChange={(v) => setSideScore(v)} disabled={!sidePreview} />
                  </div>
                  <Field
                    label="Combined /10"
                    type="number"
                    step="0.01"
                    value={combinedScore}
                    onChange={(v) => setCombinedScore(v)}
                    disabled={autoCombined}
                  />
                </div>
                <div className="app-card-strong p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Copy</div>
                  <TextField label="Headline" value={percentileLabel} onChange={setPercentileLabel} />
                  <Field
                    label={cardLang === "de" ? "Top-%" : "Top %"}
                    type="number"
                    step="1"
                    value={populationTopPercent}
                    onChange={(v) => {
                      const topPct = Math.max(1, Math.min(99, Math.round(Number(v) || 1)));
                      setPopulationTopOverride(null);
                      setCombinedScore(percentileToScore(topPct));
                    }}
                  />
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">
                      {cardLang === "de"
                        ? "Top % — Kurve (links häufiger · rechts seltener)"
                        : "Top % — curve (more common left · rarer right)"}
                    </span>
                    <input
                      type="range"
                      className="population-slider w-full mt-2"
                      min={1}
                      max={99}
                      step={1}
                      value={populationSliderUiValue}
                      onChange={(e) => {
                        const topPct = Math.max(1, Math.min(99, 100 - Number(e.target.value)));
                        setPopulationTopOverride(null);
                        setCombinedScore(percentileToScore(topPct));
                      }}
                      aria-label={
                        cardLang === "de"
                          ? "Top-Prozent für die Kurve: links häufiger, rechts seltener"
                          : "Top percent for curve: more common on the left, rarer on the right"
                      }
                    />
                    <div className="flex justify-between text-[10px] font-medium text-slate-400 mt-1">
                      <span>Top 99%</span>
                      <span>Top 50%</span>
                      <span>Top 1%</span>
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">
                      {cardLang === "de" ? "Seltenheit (score-basiert)" : "Rarity (score-based)"}
                    </span>
                    <input
                      className="mt-1 w-full h-10 rounded-xl border border-black/10 bg-slate-50 px-3 text-sm text-slate-700"
                      value={rarityLine}
                      readOnly
                    />
                  </label>
                  <div className="space-y-2">
                    <span className="text-xs font-medium text-slate-600">
                      {cardLang === "de" ? "Typische Ratios (max. 5)" : "Typical ratios (max 5)"}
                    </span>
                    <div className="flex gap-2">
                      <select
                        className="flex-1 h-10 rounded-xl border border-black/10 bg-white/90 px-3 text-sm"
                        value={ratioPicker}
                        onChange={(e) => setRatioPicker(e.target.value)}
                      >
                        {RATIO_LIBRARY.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="app-btn-secondary h-10 px-3 rounded-xl text-xs font-semibold"
                        onClick={() =>
                          setSelectedRatios((prev) => {
                            if (prev.includes(ratioPicker)) return prev;
                            if (prev.length >= 5) return prev;
                            return [...prev, ratioPicker];
                          })
                        }
                      >
                        Add
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedRatios.map((r) => (
                        <button
                          key={r}
                          type="button"
                          className="px-2 py-1 rounded-full border border-slate-200 bg-white text-[10px] text-slate-600"
                          onClick={() => setSelectedRatios((prev) => prev.filter((x) => x !== r))}
                          title="Remove"
                        >
                          {r} ×
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="app-card-strong p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Portrait</div>
                  <div>
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="portrait-file-input"
                        className="inline-flex items-center justify-center h-10 px-4 rounded-xl border border-black/10 bg-white/85 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-white transition"
                      >
                        Datei auswählen
                      </label>
                      {portraitPreview && (
                        <button
                          type="button"
                          onClick={() => clearFile(setPortraitPreview, portraitImgRef)}
                          className="inline-flex items-center justify-center h-10 px-3 rounded-xl border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-600 hover:bg-rose-100 transition"
                        >
                          Entfernen
                        </button>
                      )}
                    </div>
                    <input
                      id="portrait-file-input"
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => onFile(e.target.files?.[0] ?? null, setPortraitPreview, portraitImgRef)}
                    />
                    <p className="text-[11px] text-slate-500 mt-1.5">{portraitPreview ? "Datei ausgewählt" : "Keine Datei ausgewählt"}</p>
                  </div>
                </div>
                <div className="app-card-strong p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Header</div>
                  <TextField label="Title" value={title} onChange={setTitle} />
                  <TextField label="Subtitle" value={subtitle} onChange={setSubtitle} />
                </div>
                <div className="app-card-strong p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Grid (5 cells)</div>
                  <div className="space-y-3 max-h-[420px] overflow-y-auto custom-scroll pr-1">
                    {metricRows.slice(0, 5).map((row, i) => (
                      <div key={i} className="rounded-xl border border-black/10 bg-white/80 p-3 space-y-2">
                        <div className="text-[10px] font-bold text-slate-400">#{i + 1}</div>
                        <select
                          className="w-full h-9 rounded-lg border border-black/10 px-2 text-sm"
                          value={
                            METRIC_PRESETS.find((p) => p.label === row.label && p.value === row.value)?.key ??
                            METRIC_PRESETS[0].key
                          }
                          onChange={(e) => applyMetricPreset(i, e.target.value)}
                        >
                          {METRIC_PRESETS.map((preset) => (
                            <option
                              key={preset.key}
                              value={preset.key}
                              disabled={metricRows.slice(0, 5).some((r, ri) => {
                                if (ri === i) return false;
                                const selectedKey =
                                  METRIC_PRESETS.find((p) => p.label === r.label && p.value === r.value)?.key ?? null;
                                return selectedKey === preset.key;
                              })}
                            >
                              {preset.label}
                            </option>
                          ))}
                        </select>
                        <input
                          className="w-full h-9 rounded-lg border border-black/10 px-2 text-sm"
                          value={row.value}
                          onChange={(e) => {
                            const val = e.target.value;
                            const numeric = Number.parseFloat(val.replace(",", "."));
                            if (Number.isFinite(numeric)) {
                              updateMetric(i, {
                                value: val,
                                percent: Math.max(0, Math.min(100, Math.round(numeric * 10))),
                              });
                            } else {
                              updateMetric(i, { value: val });
                            }
                          }}
                          placeholder="Score / Label"
                        />
                        <div className="flex gap-2 items-center">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            className="w-24 h-9 rounded-lg border border-black/10 px-2 text-sm"
                            value={row.percent}
                            onChange={(e) => updateMetric(i, { percent: Number(e.target.value) })}
                          />
                          <span className="text-xs text-slate-500">% bar</span>
                          <div className="flex-1 h-9 rounded-lg border border-black/10 bg-slate-50/80 px-2 text-sm flex items-center text-slate-600">
                            Auto color
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <button
              type="button"
              onClick={() => setScreen("welcome")}
              className="app-btn-secondary w-full py-3 rounded-xl text-sm font-semibold cursor-pointer"
            >
              Back to Dashboard
            </button>
          </div>

          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold mb-1">Preview</div>
            <p className="text-xs text-slate-500 mb-3">
              Vollständige 9:16-Karte (Story/TikTok). PNG-Export in hoher Qualität: 1440 × 2560.
            </p>
            <div
              ref={previewScrollRef}
              className="max-h-[84vh] sm:max-h-[min(960px,92vh)] overflow-y-auto overflow-x-hidden custom-scroll rounded-none"
            >
              {mode === "harmony" ? (
                <HarmonyPreview
                  ref={exportCardRef}
                  frontPreview={frontPreview}
                  sidePreview={sidePreview}
                  frontScore={frontScore}
                  sideScore={sideScore}
                  combinedScore={combinedScore}
                  combinedDisplay={combinedDisplay}
                  percentileLabel={percentileLabel}
                  populationTopPercent={populationTopPercent}
                  rarityLine={rarityLine}
                  selectedRatios={selectedRatios.slice(0, 5)}
                  locale={cardLang}
                  onScoreChange={setCombinedScore}
                />
              ) : (
                <MetricsPreview
                  ref={exportCardRef}
                  title={title}
                  subtitle={subtitle}
                  portraitPreview={portraitPreview}
                  rows={metricRows}
                  locale={cardLang}
                />
              )}
            </div>
            <p className="text-xs text-slate-500 mt-4">Educational use only.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  step,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  type?: string;
  step?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input
        type={type}
        step={step}
        disabled={disabled}
        className="mt-1 w-full h-10 rounded-xl border border-black/10 bg-white/90 px-3 text-sm disabled:opacity-45"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input
        className="mt-1 w-full h-10 rounded-xl border border-black/10 bg-white/90 px-3 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

const ShareCardPreviewChrome = forwardRef<
  HTMLDivElement,
  { children: React.ReactNode; locale?: CardLocale }
>(function ShareCardPreviewChrome({ children, locale = "en" }, ref) {
  const tagline = locale === "de" ? "Gesichtsharmonie-Analyse" : "Facial harmony analysis";
  return (
    <div
      ref={ref}
      className="mx-auto w-full max-w-[min(420px,94vw)] aspect-[9/16] flex flex-col relative border border-white/80 overflow-hidden rounded-none"
      style={{
        borderRadius: "0",
        overflow: "hidden",
        boxShadow: "0 28px 90px rgba(15, 23, 42, 0.1), 0 0 0 1px rgba(255,255,255,0.85) inset",
        WebkitFontSmoothing: "antialiased",
        MozOsxFontSmoothing: "grayscale" as never,
        textRendering: "geometricPrecision",
        backgroundColor: SHARE_CARD_EXPORT_BG,
        backgroundImage:
          "radial-gradient(ellipse 115% 75% at 50% -8%, rgba(153,191,255,0.72), rgba(191,222,254,0.42) 38%, rgba(238,242,247,0.98) 100%)",
      }}
    >
      <header className="relative text-center pt-5 pb-2.5 px-5 shrink-0">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[92px]"
          style={{
            borderRadius: "0",
            background:
              "linear-gradient(180deg, rgba(153,191,255,0.38) 0%, rgba(191,222,254,0.2) 45%, rgba(238,242,247,0) 100%)",
          }}
          aria-hidden
        />
        <div className="relative z-[1]">
          <h2
            className="text-[2.65rem] sm:text-[2.85rem] leading-[1.02] font-normal text-slate-900 tracking-tight"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            LooksLab
          </h2>
          <div
            className="text-[11px] font-bold tracking-[0.38em] text-[#4A7FD4] mt-1.5"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            PRO
          </div>
          <p
            className="text-[13px] text-[#5B7AA5] mt-1.5 font-semibold"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            {tagline}
          </p>
        </div>
      </header>
      <div className="px-3 sm:px-4 pb-3 pt-1 flex-1 min-h-0 flex flex-col">{children}</div>
      <footer className="shrink-0 border-t border-slate-200/80 bg-gradient-to-b from-white/95 to-slate-50/90 py-4 px-5 flex items-center justify-center">
        <div className="flex items-center gap-3 sm:gap-4 text-[#4f678f]">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center text-[#4A7FD4]">
              <img src="/app-store.png" alt="App Store" className="w-8 h-8 rounded-[8px] object-cover" />
            </span>
            <span
              className="text-sm sm:text-base font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              LooksLab
            </span>
          </div>
          <span className="w-px h-4 bg-slate-300/80" aria-hidden />
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center text-[#4A7FD4]">
              <img src="/safari.png" alt="Safari" className="w-8 h-8 rounded-[8px] object-cover" />
            </span>
            <span
              className="text-sm sm:text-base font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              LooksLab.de
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
});

type HarmonyPreviewProps = {
  frontPreview: string | null;
  sidePreview: string | null;
  frontScore: number;
  sideScore: number;
  combinedScore: number;
  combinedDisplay: string;
  percentileLabel: string;
  populationTopPercent: number;
  rarityLine: string;
  selectedRatios: string[];
  locale: CardLocale;
  onScoreChange?: (score: number) => void;
};

const SVG_VB_WIDTH = 200;
const SCORE_AXIS_MAX = 10;

const HarmonyPreview = forwardRef<HTMLDivElement, HarmonyPreviewProps>(function HarmonyPreview(
  {
    frontPreview,
    sidePreview,
    frontScore,
    sideScore,
    combinedScore,
    combinedDisplay,
    percentileLabel,
    populationTopPercent,
    rarityLine,
    selectedRatios,
    locale,
    onScoreChange,
  },
  ref
) {
  const curveFilterId = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const chartOpts = useMemo(() => ({ width: 200, baseline: 58, peakAmp: 42 }), []);
  const { strokeD } = useMemo(() => scoreBasedCurvePaths(chartOpts), [chartOpts]);
  const curveX = scoreBasedMarkerX(combinedScore);
  const curveY = scoreBasedCurveYAtX(curveX, chartOpts);
  const L =
    locale === "de"
      ? { front: "Front", side: "Seite", dist: "Verteilung" }
      : { front: "FRONT", side: "SIDE", dist: "Distribution" };

  const pointerToScore = useCallback((clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const pxRatio = SVG_VB_WIDTH / rect.width;
    const svgX = (clientX - rect.left) * pxRatio;
    const score = (svgX / SVG_VB_WIDTH) * SCORE_AXIS_MAX;
    return Math.round(Math.max(0, Math.min(SCORE_AXIS_MAX, score)) * 10) / 10;
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!onScoreChange) return;
      dragging.current = true;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const s = pointerToScore(e.clientX);
      if (s !== null) onScoreChange(s);
    },
    [onScoreChange, pointerToScore],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || !onScoreChange) return;
      const s = pointerToScore(e.clientX);
      if (s !== null) onScoreChange(s);
    },
    [onScoreChange, pointerToScore],
  );

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const hasSide = !!sidePreview;
  return (
    <ShareCardPreviewChrome ref={ref} locale={locale}>
      <div
        className="w-full max-w-full mb-1 rounded-[24px] p-4 sm:p-5 flex flex-col items-center overflow-hidden border border-slate-200/70 bg-white/82 shadow-[0_6px_18px_rgba(15,23,42,0.05)]"
        style={{ borderRadius: "28px" }}
      >
      <div className={cn("flex justify-center gap-7 w-full shrink-0", !hasSide && "justify-center")}>
        <div className="flex flex-col items-center">
          <div
            className="w-[92px] h-[92px] rounded-full border-[2px] border-white ring-1 ring-[#8CB3F2]/45 overflow-hidden bg-gradient-to-b from-[#e8f2ff] to-[#d4e5fc] shrink-0 shadow-[0_5px_14px_rgba(91,143,217,0.15)]"
            style={
              frontPreview
                ? {
                    backgroundImage: cssBackgroundUrl(frontPreview),
                    backgroundSize: "cover",
                    backgroundPosition: "center center",
                    backgroundRepeat: "no-repeat",
                  }
                : undefined
            }
            role={frontPreview ? "img" : undefined}
            aria-hidden={frontPreview ? undefined : true}
          />
          {hasSide && (
            <>
              <div className="text-[1.15rem] font-bold text-[#4A7FD4] mt-2 tabular-nums">{frontScore.toFixed(1)}</div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.14em]">{L.front}</div>
            </>
          )}
        </div>
        {hasSide && (
          <div className="flex flex-col items-center">
            <div
              className="w-[92px] h-[92px] rounded-full border-[2px] border-white ring-1 ring-[#8CB3F2]/45 overflow-hidden bg-gradient-to-b from-[#e8f2ff] to-[#d4e5fc] shrink-0 shadow-[0_5px_14px_rgba(91,143,217,0.15)]"
              style={{
                backgroundImage: cssBackgroundUrl(sidePreview!),
                backgroundSize: "cover",
                backgroundPosition: "center center",
                backgroundRepeat: "no-repeat",
              }}
              role="img"
              aria-hidden
            />
            <div className="text-[1.15rem] font-bold text-[#4A7FD4] mt-2 tabular-nums">{sideScore.toFixed(1)}</div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.14em]">{L.side}</div>
          </div>
        )}
      </div>
      <div className="shrink-0 text-center mt-4 px-2 max-w-[360px] mx-auto w-full">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 mb-1.5">
          {locale === "de" ? "Harmonie-Score" : "Harmony score"}
        </div>
        <div className="text-[3rem] sm:text-[3.8rem] font-black text-slate-900 tabular-nums leading-none tracking-tight">
          {combinedDisplay}
        </div>
        <div className="text-slate-500 text-[14px] font-semibold mt-1 opacity-90">
          {locale === "de" ? "von 10" : "/ 10"}
        </div>
        <div
          className={cn(
            "mt-4 grid gap-0 w-full max-w-[340px] mx-auto rounded-xl border border-slate-200/80 bg-white/75 text-center",
            rarityLine ? "grid-cols-3" : "grid-cols-2"
          )}
          style={{ fontFamily: "var(--font-sans)" }}
        >
          <div className="px-2 py-3 border-r border-slate-200/60">
            <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-1">
              {locale === "de" ? "Perzentil" : "Percentile"}
            </div>
            <div className="text-[13px] font-semibold text-[#3d73c9] leading-tight">{percentileLabel}</div>
          </div>
          <div className={cn("px-2 py-3", rarityLine && "border-r border-slate-200/60")}>
            <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-1">
              {locale === "de" ? "Rang" : "Rank"}
            </div>
            <div className="text-[13px] font-semibold text-slate-800 tabular-nums leading-tight">{getTopBottomLabel(populationTopPercent)}</div>
          </div>
          {rarityLine && (
            <div className="px-2 py-3 min-h-[52px] flex flex-col justify-center">
              <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-1">
                {locale === "de" ? "Seltenheit" : "Rarity"}
              </div>
              <div className="text-[13px] font-medium text-slate-700 tabular-nums leading-tight">{rarityLine}</div>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3.5 w-full max-w-full mx-auto shrink-0">
        <div className="rounded-[16px] border border-slate-200/55 bg-gradient-to-b from-[#faf8f6] via-[#f6f4f9] to-[#ebe8f2] shadow-[0_4px_12px_rgba(55,48,74,0.05)]">
          <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-slate-500/90 text-center pt-3 px-4">
            {L.dist}
          </div>
          <div className="px-4 pb-5 pt-1">
            <svg
              ref={svgRef}
              viewBox="-18 -4 236 80"
              className="w-full touch-none select-none"
              preserveAspectRatio="xMidYMid meet"
              style={{ cursor: onScoreChange ? "crosshair" : undefined }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {/* Section divider lines — from above label down to baseline */}
              {[2, 3, 4, 5, 6, 7, 8].map((s) => {
                const sx = s * 20;
                const cy = scoreBasedCurveYAtX(sx, chartOpts);
                return (
                  <line
                    key={s}
                    x1={sx}
                    y1={cy - 9}
                    x2={sx}
                    y2={58}
                    stroke="rgba(130,135,155,0.22)"
                    strokeWidth="0.5"
                  />
                );
              })}
              {/* Baseline */}
              <line x1={-8} y1={58} x2={208} y2={58} stroke="#4A7FD4" strokeOpacity={0.8} strokeWidth="1" strokeLinecap="round" />
              {/* Curve stroke */}
              <path
                d={strokeD}
                fill="none"
                stroke="#4A7FD4"
                strokeOpacity={0.9}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Section percentage labels — above curve */}
              {SCORE_SECTIONS.map((sec) => {
                const midX = ((sec.from + sec.to) / 2) * 20;
                const cy = scoreBasedCurveYAtX(midX, chartOpts);
                return (
                  <text
                    key={sec.from}
                    x={midX}
                    y={cy - 10.5}
                    textAnchor="middle"
                    fill="#3a3f4d"
                    fontSize="5.4"
                    fontWeight="700"
                    fontFamily="var(--font-sans), system-ui, sans-serif"
                  >
                    {sec.pct}
                  </text>
                );
              })}
              {/* Marker drop line */}
              <line
                x1={curveX}
                y1={curveY}
                x2={curveX}
                y2={58}
                stroke="rgba(74,127,212,0.35)"
                strokeWidth="0.75"
                strokeDasharray="2.5 3.5"
              />
              {/* Marker hit area */}
              {onScoreChange && (
                <circle cx={curveX} cy={curveY} r="14" fill="transparent" style={{ cursor: "grab" }} />
              )}
              {/* Marker dot */}
              <circle
                cx={curveX}
                cy={curveY}
                r="3.8"
                fill="#fffcfa"
                stroke="#4A7FD4"
                strokeWidth="1.3"
                style={{ cursor: onScoreChange ? "grab" : undefined }}
              />
              <circle cx={curveX} cy={curveY} r="1.5" fill="#4A7FD4" fillOpacity={0.9} style={{ pointerEvents: "none" }} />
              {/* Score axis labels 0–10 */}
              {Array.from({ length: 11 }, (_, i) => (
                <text
                  key={i}
                  x={i * 20}
                  y={68}
                  textAnchor="middle"
                  fill="#3a3f4d"
                  fontSize="5.2"
                  fontWeight="700"
                  fontFamily="var(--font-sans), system-ui, sans-serif"
                >
                  {i}
                </text>
              ))}
            </svg>
          </div>
        </div>
      </div>
      </div>
    </ShareCardPreviewChrome>
  );
});

const toneBar: Record<NonNullable<MetricRow["tone"]>, string> = {
  blue: "bg-[#8CB3F2]",
  green: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
};

type MetricsPreviewProps = {
  title: string;
  subtitle: string;
  portraitPreview: string | null;
  rows: MetricRow[];
  locale: CardLocale;
};

const MetricsPreview = forwardRef<HTMLDivElement, MetricsPreviewProps>(function MetricsPreview(
  { title, subtitle, portraitPreview, rows, locale },
  ref
) {
  const grid = rows.slice(0, 5);
  const overviewLabel = locale === "de" ? "Kennzahlübersicht" : "Metrics overview";
  const moreRatiosLine =
    locale === "de" ? "55 weitere Ratios zum Entdecken" : "55 more ratios to explore";
  return (
    <ShareCardPreviewChrome ref={ref} locale={locale}>
      <div
        className="app-card-strong w-full max-w-full mx-1 mb-2 rounded-[26px] p-4 flex flex-col items-center border border-black/10 overflow-hidden"
        style={{ borderRadius: "26px" }}
      >
      <div className="text-[10px] font-bold text-slate-400 tracking-[0.2em] uppercase">{overviewLabel}</div>
      <div
        className="w-[76px] h-[76px] rounded-full border-[3px] border-[#8CB3F2] overflow-hidden mt-2.5 bg-[#BFDEFE]/50"
        style={{
          boxShadow: "0 8px 22px rgba(140,179,242,0.3)",
          ...(portraitPreview
            ? {
                backgroundImage: cssBackgroundUrl(portraitPreview),
                backgroundSize: "cover",
                backgroundPosition: "center center",
                backgroundRepeat: "no-repeat",
              }
            : {}),
        }}
        role={portraitPreview ? "img" : undefined}
        aria-hidden={portraitPreview ? undefined : true}
      />
      <h2
        className="text-2xl font-normal text-slate-900 mt-2.5 text-center leading-tight"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {title}
      </h2>
      <p className="text-xs text-slate-500 font-medium" style={{ fontFamily: "var(--font-sans)" }}>{subtitle}</p>
      <div className="w-full mt-4 rounded-2xl border border-slate-200/70 bg-white/70 divide-y divide-slate-100 overflow-hidden">
        {grid.map((row, i) => (
          <div key={i} className="flex items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div
                className="text-[10px] font-semibold text-slate-500 uppercase tracking-[0.08em] truncate"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                {row.label}
              </div>
              <div
                className="text-[17px] font-bold text-slate-900 tabular-nums leading-tight mt-0.5 truncate"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                {row.value}
              </div>
            </div>
            <div className="w-[88px] shrink-0">
              <div className="h-1 rounded-full bg-slate-200/90 overflow-hidden">
                <div
                  className={cn("h-full rounded-full", toneBar[toneFromPercent(row.percent)])}
                  style={{ width: `${Math.min(100, Math.max(0, row.percent))}%` }}
                />
              </div>
              <div
                className="text-[9px] font-medium text-slate-400 text-right mt-1 tabular-nums"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                {row.percent}%
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[11px] font-semibold text-[#5B7AA5]">{moreRatiosLine}</div>
      </div>
    </ShareCardPreviewChrome>
  );
});
