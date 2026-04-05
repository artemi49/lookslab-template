"use client";

import { cn } from "@/lib/cn";
import {
  calculateCombinedScore,
  calculatePercentile,
  calculatePercentileTopDecimal,
  clampTopPercentDecimal,
  formatRankTopPercent,
  getPercentileLabelLocalized,
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

/** Rank / curve “Top n%”: follow combined score, or fixed manually without changing the score. */
type PopulationRankSource = "score" | "manual";

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

/**
 * Every PNG is captured from this exact CSS pixel frame so typography/layout match on all devices.
 * Preview may scale down on narrow screens; export temporarily snaps the live node to this box.
 */
const EXPORT_CARD_CSS_WIDTH = 420;
const EXPORT_CARD_CSS_HEIGHT = Math.round((EXPORT_CARD_CSS_WIDTH * 16) / 9);

function isLikelyMobileExportHost(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod|Android.*Mobile/i.test(ua);
}

/**
 * Wait for every `<img>` under `root` to load + decode, then convert any
 * non-data-URL src to an inline data URL. On mobile Safari html-to-image
 * fails to fetch relative `/foo.png` paths during export; inlining fixes that.
 */
async function warmAndInlineDomImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (img) => {
      if (!img.complete) {
        await new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        });
      }
      // Convert relative / absolute (non-data) URLs to inline data URLs
      if (img.src && !img.src.startsWith("data:") && img.naturalWidth > 0) {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            img.src = c.toDataURL("image/png");
          }
        } catch { /* CORS taint — leave as-is */ }
      }
      try { await img.decode(); } catch { /* unsupported or already decoded */ }
    })
  );
}

/** Rounded user photo: real `<img>` + `data-face-photo` for canvas compositing fallback. */
function HarmonyFacePhoto({ src, photoId }: { src: string | null; photoId?: string }) {
  return (
    <div
      className="relative w-[92px] h-[92px] rounded-full border-[2px] border-white ring-1 ring-[#8CB3F2]/45 overflow-hidden bg-gradient-to-b from-[#e8f2ff] to-[#d4e5fc] shrink-0 shadow-[0_5px_14px_rgba(91,143,217,0.15)]"
      role={src ? "img" : undefined}
      aria-hidden={src ? undefined : true}
      data-face-photo={photoId}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={92}
          height={92}
          className="absolute inset-0 h-full w-full object-cover object-center pointer-events-none select-none"
          style={{ display: "block", WebkitTransform: "translateZ(0)" }}
          draggable={false}
        />
      ) : null}
    </div>
  );
}

function MetricsPortraitPhoto({ src }: { src: string | null }) {
  return (
    <div
      className="relative w-[76px] h-[76px] rounded-full border-[3px] border-[#8CB3F2] overflow-hidden mt-2.5 bg-[#BFDEFE]/50"
      style={{ boxShadow: "0 8px 22px rgba(140,179,242,0.3)" }}
      role={src ? "img" : undefined}
      aria-hidden={src ? undefined : true}
      data-face-photo="portrait"
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={76}
          height={76}
          className="absolute inset-0 h-full w-full object-cover object-center pointer-events-none select-none"
          style={{ display: "block", WebkitTransform: "translateZ(0)" }}
          draggable={false}
        />
      ) : null}
    </div>
  );
}

const defaultMetricsEn: MetricRow[] = [
  { label: "Harmony", value: "7.5", percent: 75, tone: "blue" },
  { label: "Structure", value: "Good", percent: 72, tone: "green" },
  { label: "Eyes", value: "6.8", percent: 68, tone: "blue" },
  { label: "Midface", value: "6.2", percent: 62, tone: "amber" },
  { label: "Lower third", value: "7.1", percent: 71, tone: "green" },
];
const defaultMetricsDe: MetricRow[] = [
  { label: "Harmonie", value: "7,5", percent: 75, tone: "blue" },
  { label: "Struktur", value: "Gut", percent: 72, tone: "green" },
  { label: "Augen", value: "6,8", percent: 68, tone: "blue" },
  { label: "Mittelgesicht", value: "6,2", percent: 62, tone: "amber" },
  { label: "Unteres Drittel", value: "7,1", percent: 71, tone: "green" },
];

type PresetRow = MetricRow & { key: string; labelDe: string; valueDe: string };

const METRIC_PRESETS: PresetRow[] = [
  { key: "harmony", label: "Harmony", labelDe: "Harmonie", value: "7.5", valueDe: "7,5", percent: 75, tone: "blue" },
  { key: "structure", label: "Structure", labelDe: "Struktur", value: "Good", valueDe: "Gut", percent: 72, tone: "green" },
  { key: "eyes", label: "Eyes", labelDe: "Augen", value: "6.8", valueDe: "6,8", percent: 68, tone: "blue" },
  { key: "midface", label: "Midface", labelDe: "Mittelgesicht", value: "6.2", valueDe: "6,2", percent: 62, tone: "amber" },
  { key: "lower-third", label: "Lower third", labelDe: "Unteres Drittel", value: "7.1", valueDe: "7,1", percent: 71, tone: "green" },
  { key: "upper-third", label: "Upper third", labelDe: "Oberes Drittel", value: "6.5", valueDe: "6,5", percent: 65, tone: "amber" },
  { key: "nose", label: "Nose", labelDe: "Nase", value: "6.7", valueDe: "6,7", percent: 67, tone: "blue" },
  { key: "jawline", label: "Jawline", labelDe: "Kieferlinie", value: "6.9", valueDe: "6,9", percent: 69, tone: "green" },
  { key: "lips", label: "Lips", labelDe: "Lippen", value: "6.4", valueDe: "6,4", percent: 64, tone: "amber" },
  { key: "symmetry", label: "Symmetry", labelDe: "Symmetrie", value: "7.0", valueDe: "7,0", percent: 70, tone: "green" },
];

function presetLabel(p: PresetRow, locale: CardLocale): string {
  return locale === "de" ? p.labelDe : p.label;
}
function presetValue(p: PresetRow, locale: CardLocale): string {
  return locale === "de" ? p.valueDe : p.value;
}

function toneFromPercent(percent: number): NonNullable<MetricRow["tone"]> {
  if (percent >= 70) return "green";
  if (percent >= 65) return "blue";
  if (percent >= 40) return "amber";
  return "rose";
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // data: and blob: are same-origin; anonymous avoids taint when drawing to canvas on some engines
    if (!url.startsWith("data:") && !url.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = url;
  });
}

/** Max pixel dimension for user-uploaded photos; keeps data URLs small enough for mobile Safari. */
const UPLOAD_MAX_DIM = 640;

function resizeImageToDataURL(file: File, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      let { width: w, height: h } = img;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas context failed")); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error("Image load failed during resize"));
    };
    img.src = blobUrl;
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

    ctx.fillStyle = SHARE_CARD_EXPORT_BG;
    ctx.fillRect(0, 0, TIKTOK_EXPORT_WIDTH, TIKTOK_EXPORT_HEIGHT);

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

/* ── Canvas compositing: draw user photos directly onto the captured PNG ─────
 * Both html2canvas and html-to-image frequently drop user photos on iOS/WebKit.
 * After any capture, we locate the photo circles via `data-face-photo`, then
 * draw each loaded HTMLImageElement onto the raster with circular clipping.
 * This is a pure Canvas 2D operation — no DOM cloning involved.
 */

type PhotoOverlay = {
  img: HTMLImageElement;
  xFrac: number;
  yFrac: number;
  wFrac: number;
  hFrac: number;
};

/**
 * Scan the live DOM card for `[data-face-photo]` containers that have a loaded
 * `<img>` inside. Uses the actual rendered DOM elements — never relies on React refs
 * which may be null on mobile due to large-image memory pressure.
 */
function collectPhotoOverlaysFromDom(cardEl: HTMLElement): PhotoOverlay[] {
  const cardRect = cardEl.getBoundingClientRect();
  if (cardRect.width < 1 || cardRect.height < 1) return [];
  const overlays: PhotoOverlay[] = [];
  const containers = cardEl.querySelectorAll<HTMLElement>("[data-face-photo]");
  for (const container of containers) {
    const img = container.querySelector<HTMLImageElement>("img");
    if (!img || !img.src || !img.complete || img.naturalWidth === 0) continue;
    const r = container.getBoundingClientRect();
    overlays.push({
      img,
      xFrac: (r.left - cardRect.left) / cardRect.width,
      yFrac: (r.top - cardRect.top) / cardRect.height,
      wFrac: r.width / cardRect.width,
      hFrac: r.height / cardRect.height,
    });
  }
  return overlays;
}

async function compositePhotosOnBlob(blob: Blob, overlays: PhotoOverlay[]): Promise<Blob> {
  if (overlays.length === 0) return blob;
  const srcUrl = URL.createObjectURL(blob);
  try {
    const bg = await loadImageFromUrl(srcUrl);
    const canvas = document.createElement("canvas");
    canvas.width = bg.naturalWidth || bg.width;
    canvas.height = bg.naturalHeight || bg.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;

    ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);

    for (const o of overlays) {
      // Re-decode to ensure the image is still rasterised in GPU memory on iOS
      try { await o.img.decode(); } catch { /* already decoded or unsupported */ }

      const dx = o.xFrac * canvas.width;
      const dy = o.yFrac * canvas.height;
      const dw = o.wFrac * canvas.width;
      const dh = o.hFrac * canvas.height;
      const cx = dx + dw / 2;
      const cy = dy + dh / 2;
      const radius = Math.min(dw, dh) / 2;

      const srcW = o.img.naturalWidth || o.img.width;
      const srcH = o.img.naturalHeight || o.img.height;
      if (srcW === 0 || srcH === 0) continue;
      const destRatio = dw / dh;
      const srcRatio = srcW / srcH;
      let sw: number, sh: number, sx: number, sy: number;
      if (srcRatio > destRatio) {
        sh = srcH;
        sw = sh * destRatio;
        sx = (srcW - sw) / 2;
        sy = 0;
      } else {
        sw = srcW;
        sh = sw / destRatio;
        sx = 0;
        sy = (srcH - sh) / 2;
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(o.img, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();
    }

    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b ?? blob), "image/png", 1);
    });
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}

/**
 * Primary raster path for Next.js / Turbopack: avoids html-to-image reading `document.styleSheets[].cssRules`
 * (opaque cross-origin sheets → SecurityError). html-to-image is only used as fallback with `skipFonts: true`.
 *
 * Measure the live node after `exportPng` snaps it to `EXPORT_CARD_CSS_*`, set `windowWidth`/`windowHeight`
 * to that exact box, and keep `onclone` minimal — mismatched iframe viewport size produces blank PNGs.
 */
type Html2CanvasExportExtra = {
  /** Cap scale to avoid blank / OOM canvases on some mobile GPUs. */
  maxScale?: number;
  foreignObjectRendering?: boolean;
};

async function cardToPngBlobHtml2Canvas(
  el: HTMLElement,
  targetWidth: number,
  extra?: Html2CanvasExportExtra
): Promise<Blob | null> {
  const rect = el.getBoundingClientRect();
  const cssW = Math.max(1, rect.width);
  const cssH = Math.max(1, rect.height);
  let scale = targetWidth / cssW;
  if (extra?.maxScale != null) {
    scale = Math.min(scale, extra.maxScale);
  }

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
    foreignObjectRendering: extra?.foreignObjectRendering ?? false,
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
  const [populationRankSource, setPopulationRankSource] = useState<PopulationRankSource>("score");
  /** Manual “Top n%” (0.1–99, step 0.1); only used when `populationRankSource === "manual"`. */
  const [populationTopOverride, setPopulationTopOverride] = useState<number | null>(null);

  const populationTopPercent = useMemo(() => {
    const fromScore = calculatePercentileTopDecimal(combinedScore);
    if (populationRankSource === "manual") {
      return clampTopPercentDecimal(populationTopOverride ?? fromScore);
    }
    return fromScore;
  }, [combinedScore, populationRankSource, populationTopOverride]);

  const rarityLine = useMemo(() => {
    const top = clampTopPercentDecimal(populationTopPercent);
    if (top <= 50) {
      const n = Math.max(2, Math.round(100 / top));
      return cardLang === "de" ? `1 von ${n}` : `1 in ${n}`;
    }
    return "";
  }, [populationTopPercent, cardLang]);

  const populationSliderUiValue = Math.round((100 - populationTopPercent) * 10) / 10;

  const applyTopPercentPreset = (raw: number) => {
    const topPct = clampTopPercentDecimal(raw);
    if (populationRankSource === "manual") {
      setPopulationTopOverride(topPct);
    } else {
      setCombinedScore(percentileToScore(topPct));
    }
  };

  const [title, setTitle] = useState("Your profile");
  const [subtitle, setSubtitle] = useState("Harmony map");
  const [metricRows, setMetricRows] = useState<MetricRow[]>(defaultMetricsEn);
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

  useEffect(() => {
    const titlePairs = [["Your profile", "Dein Profil"], ["Harmony map", "Harmonie-Karte"]] as const;
    setTitle((prev) => {
      const pair = titlePairs[0];
      if (cardLang === "de" && prev === pair[0]) return pair[1];
      if (cardLang === "en" && prev === pair[1]) return pair[0];
      return prev;
    });
    setSubtitle((prev) => {
      const pair = titlePairs[1];
      if (cardLang === "de" && prev === pair[0]) return pair[1];
      if (cardLang === "en" && prev === pair[1]) return pair[0];
      return prev;
    });
    setMetricRows((prev) =>
      prev.map((row) => {
        const preset = METRIC_PRESETS.find(
          (p) => p.label === row.label || p.labelDe === row.label
        );
        if (!preset) return row;
        return {
          ...row,
          label: presetLabel(preset, cardLang),
          value: presetValue(preset, cardLang),
        };
      })
    );
  }, [cardLang]);

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
    void resizeImageToDataURL(file, UPLOAD_MAX_DIM)
      .then((dataUrl) => {
        setPreview(dataUrl);
        return loadImageFromUrl(dataUrl);
      })
      .then((img) => {
        ref.current = img;
      })
      .catch(() => {});
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
    await warmAndInlineDomImages(el);

    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    await new Promise<void>((r) => setTimeout(r, 50));

    // `mx-auto` → large L/R margins in a wide column; zero margins so clone matches export (lookslabmedia-next).
    const prevCardMarginLeft = el.style.marginLeft;
    const prevCardMarginRight = el.style.marginRight;
    el.style.marginLeft = "0";
    el.style.marginRight = "0";

    const prevExportBox = {
      width: el.style.width,
      minWidth: el.style.minWidth,
      maxWidth: el.style.maxWidth,
      height: el.style.height,
      minHeight: el.style.minHeight,
      maxHeight: el.style.maxHeight,
      aspectRatio: el.style.aspectRatio,
    };
    el.style.width = `${EXPORT_CARD_CSS_WIDTH}px`;
    el.style.minWidth = `${EXPORT_CARD_CSS_WIDTH}px`;
    el.style.maxWidth = `${EXPORT_CARD_CSS_WIDTH}px`;
    el.style.height = `${EXPORT_CARD_CSS_HEIGHT}px`;
    el.style.minHeight = `${EXPORT_CARD_CSS_HEIGHT}px`;
    el.style.maxHeight = `${EXPORT_CARD_CSS_HEIGHT}px`;
    el.style.aspectRatio = "auto";

    void el.offsetWidth;
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    await new Promise<void>((r) => setTimeout(r, 80));

    // Collect photo positions from live DOM while card is in export layout.
    const photoOverlays = collectPhotoOverlaysFromDom(el);

    const br = el.getBoundingClientRect();
    const w = Math.max(2, Math.round(br.width));
    let h = Math.max(2, Math.round(br.height));
    h = Math.min(h, 8192);
    if (w < 2 || h < 2) {
      el.style.width = prevExportBox.width;
      el.style.minWidth = prevExportBox.minWidth;
      el.style.maxWidth = prevExportBox.maxWidth;
      el.style.height = prevExportBox.height;
      el.style.minHeight = prevExportBox.minHeight;
      el.style.maxHeight = prevExportBox.maxHeight;
      el.style.aspectRatio = prevExportBox.aspectRatio;
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

    const commonOpts = {
      cacheBust: false as const,
      imagePlaceholder: EXPORT_IMAGE_PLACEHOLDER,
    };

    const exportAttempts: Array<{ pixelRatio: number; useMeasuredSize?: boolean }> = [
      { pixelRatio },
      { pixelRatio: Math.min(pixelRatio, 2) },
      { pixelRatio: 1 },
      { pixelRatio: 1, useMeasuredSize: true },
    ];

    const mobile = isLikelyMobileExportHost();
    await warmAndInlineDomImages(el);

    // Hide user photos so the DOM capture only draws the card chrome.
    // We composite the photos ourselves afterwards (avoids double-render shift on mobile).
    const userPhotoImgs = Array.from(
      el.querySelectorAll<HTMLImageElement>("[data-face-photo] img")
    );
    userPhotoImgs.forEach((img) => { img.style.visibility = "hidden"; });

    try {
      let blob: Blob | null = null;
      let lastErr: unknown;

      const tryHtmlToImage = async () => {
        for (const attempt of exportAttempts) {
          try {
            const b = await toBlob(el, {
              ...commonOpts,
              skipFonts: true,
              pixelRatio: attempt.pixelRatio,
              ...(attempt.useMeasuredSize ? {} : { width: w, height: h }),
            });
            if (b) return b;
          } catch (err) {
            lastErr = err;
          }
        }
        return null;
      };

      if (mobile) {
        blob = await tryHtmlToImage();
        if (!blob) {
          try {
            blob = await cardToPngBlobHtml2Canvas(el, targetW, { maxScale: 2 });
          } catch (h2cErr) {
            lastErr = h2cErr;
            console.warn("html2canvas (mobile) failed:", h2cErr);
          }
        }
        if (!blob) {
          try {
            blob = await cardToPngBlobHtml2Canvas(el, targetW, {
              maxScale: 2,
              foreignObjectRendering: true,
            });
          } catch (h2cErr) {
            lastErr = h2cErr;
          }
        }
      } else {
        try {
          blob = await cardToPngBlobHtml2Canvas(el, targetW);
        } catch (h2cErr) {
          lastErr = h2cErr;
          console.warn("html2canvas export failed, trying html-to-image:", h2cErr);
        }
        if (!blob) {
          blob = await tryHtmlToImage();
        }
      }

      // Restore user photos before we read their positions / pixels for compositing.
      userPhotoImgs.forEach((img) => { img.style.visibility = ""; });

      if (!blob) {
        console.error("PNG export failed after html2canvas + html-to-image:", lastErr);
        return;
      }

      // Draw user photos via Canvas 2D — always, since we hid them during capture.
      if (photoOverlays.length > 0) {
        blob = await compositePhotosOnBlob(blob, photoOverlays);
      }

      const finalBlob = (await normalizeToTikTokSize(blob)) ?? blob;
      downloadPngBlob(
        finalBlob,
        mode === "harmony" ? "lookslab-harmony-card.png" : "lookslab-metrics-card.png"
      );
    } catch (e) {
      console.error("PNG export failed:", e);
    } finally {
      // Ensure user photos are always visible again even if export threw.
      userPhotoImgs.forEach((img) => { img.style.visibility = ""; });
      el.style.width = prevExportBox.width;
      el.style.minWidth = prevExportBox.minWidth;
      el.style.maxWidth = prevExportBox.maxWidth;
      el.style.height = prevExportBox.height;
      el.style.minHeight = prevExportBox.minHeight;
      el.style.maxHeight = prevExportBox.maxHeight;
      el.style.aspectRatio = prevExportBox.aspectRatio;
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
      label: presetLabel(preset, cardLang),
      value: presetValue(preset, cardLang),
      percent: preset.percent,
      tone: preset.tone,
    });
  };

  return (
    <div className="min-h-full app-surface px-4 py-5 sm:px-6 sm:py-6 lg:px-10 lg:py-8 pb-12 sm:pb-16">
      <div className="max-w-[1400px] mx-auto w-full">
        <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between mb-6 sm:mb-8">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.22em] text-[#5B8FD9] uppercase mb-1">Studio export</p>
            <h1 className="text-[1.65rem] leading-tight sm:text-3xl md:text-4xl text-slate-900 font-normal" style={{ fontFamily: "var(--font-serif)" }}>
              Image Create
            </h1>
            <p className="text-sm text-slate-500 mt-2 max-w-xl">
              LooksLab wordmark and LooksLab.de on every export — same fonts as the app (Instrument Serif + Plus Jakarta Sans).
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto shrink-0">
            <button
              type="button"
              onClick={exportPng}
              className="app-btn-primary px-5 py-3 sm:py-2.5 rounded-xl text-sm font-semibold cursor-pointer w-full sm:w-auto inline-flex items-center justify-center min-h-[44px] sm:min-h-0"
            >
              Download PNG
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-stretch sm:items-center gap-2 sm:gap-3 mb-6">
          <div className="flex flex-wrap gap-2">
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
          <span className="hidden sm:block w-px h-5 bg-slate-300/60 self-center" aria-hidden />
          <div className="flex flex-wrap gap-1">
            {(["en", "de"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setCardLang(l)}
                className={cn(
                  "px-3 py-2 rounded-xl text-xs font-bold uppercase border transition-all cursor-pointer tracking-wide",
                  cardLang === l
                    ? "bg-[#BFDEFE]/80 border-[#8CB3F2] text-slate-900 shadow-[0_6px_18px_rgba(140,179,242,0.35)]"
                    : "bg-white/70 border-black/10 text-slate-500 hover:bg-white"
                )}
              >
                {l === "en" ? "EN" : "DE"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 md:gap-8 xl:grid-cols-[minmax(280px,440px)_minmax(0,1fr)] xl:items-start">
          <div className="space-y-4 sm:space-y-5 order-2 xl:order-1 min-w-0">
            {mode === "harmony" ? (
              <>
                <div className="app-card-strong p-4 sm:p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Photos</div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2">Front (required for best result)</label>
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor="front-file-input"
                        className="inline-flex items-center justify-center h-10 px-4 rounded-xl border border-black/10 bg-white/85 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-white transition"
                      >
                        Select file
                      </label>
                      {frontPreview && (
                        <button
                          type="button"
                          onClick={() => clearFile(setFrontPreview, frontImgRef)}
                          className="inline-flex items-center justify-center h-10 px-3 rounded-xl border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-600 hover:bg-rose-100 transition"
                        >
                          Remove
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
                    <p className="text-[11px] text-slate-500 mt-1.5">{frontPreview ? "File selected" : "No file selected"}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2">Side (optional)</label>
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor="side-file-input"
                        className="inline-flex items-center justify-center h-10 px-4 rounded-xl border border-black/10 bg-white/85 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-white transition"
                      >
                        Select file
                      </label>
                      {sidePreview && (
                        <button
                          type="button"
                          onClick={() => clearFile(setSidePreview, sideImgRef)}
                          className="inline-flex items-center justify-center h-10 px-3 rounded-xl border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-600 hover:bg-rose-100 transition"
                        >
                          Remove
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
                    <p className="text-[11px] text-slate-500 mt-1.5">{sidePreview ? "File selected" : "No file selected"}</p>
                  </div>
                </div>
                <div className="app-card-strong p-4 sm:p-5 space-y-4">
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
                  <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-3">
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
                <div className="app-card-strong p-4 sm:p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Copy</div>
                  <TextField label="Headline" value={percentileLabel} onChange={setPercentileLabel} />
                  <div className="rounded-xl border border-black/10 bg-white/60 p-3 space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-slate-700">
                          {cardLang === "de" ? "Top % — Kurve" : "Top % — curve"}
                        </div>
                        <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">
                          {cardLang === "de"
                            ? "Links häufiger · rechts seltener"
                            : "More common left · rarer right"}
                        </p>
                      </div>
                      <div
                        className="flex shrink-0 rounded-xl border border-black/10 bg-slate-100/90 p-0.5 gap-0.5"
                        role="group"
                        aria-label={cardLang === "de" ? "Top-% Quelle" : "Top % source"}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setPopulationRankSource("score");
                            setPopulationTopOverride(null);
                          }}
                          className={cn(
                            "px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wide transition-all cursor-pointer",
                            populationRankSource === "score"
                              ? "bg-white text-slate-900 shadow-sm border border-black/5"
                              : "text-slate-500 hover:text-slate-700"
                          )}
                        >
                          {cardLang === "de" ? "Vom Score" : "From score"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPopulationRankSource("manual");
                            setPopulationTopOverride(calculatePercentileTopDecimal(combinedScore));
                          }}
                          className={cn(
                            "px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wide transition-all cursor-pointer",
                            populationRankSource === "manual"
                              ? "bg-white text-slate-900 shadow-sm border border-black/5"
                              : "text-slate-500 hover:text-slate-700"
                          )}
                        >
                          {cardLang === "de" ? "Eigener %" : "Custom %"}
                        </button>
                      </div>
                    </div>
                    <Field
                      label={cardLang === "de" ? "Top % (Rang / Kurve)" : "Top % (rank / curve)"}
                      type="number"
                      step="0.1"
                      value={populationTopPercent}
                      onChange={(v) => {
                        const topPct = clampTopPercentDecimal(Number(v) || 0.1);
                        if (populationRankSource === "manual") {
                          setPopulationTopOverride(topPct);
                        } else {
                          setCombinedScore(percentileToScore(topPct));
                        }
                      }}
                    />
                    <div>
                      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                        {cardLang === "de" ? "Schnellwahl" : "Quick presets"}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {([1, 3, 5, 10, 15, 25, 50] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => applyTopPercentPreset(p)}
                            className="px-2.5 py-1.5 rounded-lg border border-black/10 bg-white/90 text-[10px] font-bold text-slate-600 hover:bg-[#BFDEFE]/50 hover:border-[#8CB3F2]/60 transition-colors cursor-pointer"
                          >
                            Top {p}%
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="block">
                      <span className="sr-only">
                        {cardLang === "de"
                          ? "Top-Prozent für Kurve und Rang"
                          : "Top percent for curve and rank"}
                      </span>
                      <input
                        type="range"
                        className="population-slider w-full mt-1"
                        min={1}
                        max={99.9}
                        step={0.1}
                        value={populationSliderUiValue}
                        onChange={(e) => {
                          const topPct = clampTopPercentDecimal(100 - Number(e.target.value));
                          if (populationRankSource === "manual") {
                            setPopulationTopOverride(topPct);
                          } else {
                            setCombinedScore(percentileToScore(topPct));
                          }
                        }}
                        aria-label={
                          cardLang === "de"
                            ? "Top-Prozent: links häufiger, rechts seltener"
                            : "Top percent: more common left, rarer right"
                        }
                      />
                      <div className="flex justify-between text-[10px] font-medium text-slate-400 mt-1">
                        <span>Top 99%</span>
                        <span>Top 50%</span>
                        <span>Top 1%</span>
                      </div>
                    </label>
                  </div>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">
                      Rarity (score-based)
                    </span>
                    <input
                      className="mt-1 w-full h-10 rounded-xl border border-black/10 bg-slate-50 px-3 text-sm text-slate-700"
                      value={rarityLine}
                      readOnly
                    />
                  </label>
                </div>
              </>
            ) : (
              <>
                <div className="app-card-strong p-4 sm:p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Portrait</div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        htmlFor="portrait-file-input"
                        className="inline-flex items-center justify-center h-10 px-4 rounded-xl border border-black/10 bg-white/85 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-white transition"
                      >
                        Select file
                      </label>
                      {portraitPreview && (
                        <button
                          type="button"
                          onClick={() => clearFile(setPortraitPreview, portraitImgRef)}
                          className="inline-flex items-center justify-center h-10 px-3 rounded-xl border border-rose-200 bg-rose-50 text-xs font-semibold text-rose-600 hover:bg-rose-100 transition"
                        >
                          Remove
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
                    <p className="text-[11px] text-slate-500 mt-1.5">{portraitPreview ? "File selected" : "No file selected"}</p>
                  </div>
                </div>
                <div className="app-card-strong p-4 sm:p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Header</div>
                  <TextField label="Title" value={title} onChange={setTitle} />
                  <TextField label="Subtitle" value={subtitle} onChange={setSubtitle} />
                </div>
                <div className="app-card-strong p-4 sm:p-5 space-y-4">
                  <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold">Grid (5 cells)</div>
                  <div className="space-y-3 max-h-[min(420px,52vh)] sm:max-h-[420px] overflow-y-auto custom-scroll pr-1">
                    {metricRows.slice(0, 5).map((row, i) => (
                      <div key={i} className="rounded-xl border border-black/10 bg-white/80 p-3 space-y-2">
                        <div className="text-[10px] font-bold text-slate-400">#{i + 1}</div>
                        <select
                          className="w-full h-9 rounded-lg border border-black/10 px-2 text-sm"
                          value={
                            METRIC_PRESETS.find((p) => p.label === row.label || p.labelDe === row.label)?.key ??
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
                                  METRIC_PRESETS.find((p) => p.label === r.label || p.labelDe === r.label)?.key ?? null;
                                return selectedKey === preset.key;
                              })}
                            >
                              {presetLabel(preset, cardLang)}
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
          </div>

          <div className="min-w-0 order-1 xl:order-2 xl:sticky xl:top-5 xl:self-start">
            <div className="text-[11px] uppercase tracking-widest text-slate-400 font-semibold mb-1">Preview</div>
            <p className="text-xs text-slate-500 mb-3">
              Full 9:16 card (Story/TikTok). Export is always {EXPORT_CARD_CSS_WIDTH}×{EXPORT_CARD_CSS_HEIGHT}px layout → 1440×2560 PNG.
            </p>
            <div
              ref={previewScrollRef}
              className="max-h-[min(72vh,820px)] sm:max-h-[min(84vh,920px)] lg:max-h-[min(88vh,960px)] overflow-y-auto overflow-x-hidden custom-scroll rounded-none -mx-1 px-1 sm:mx-0 sm:px-0"
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
      className="mx-auto w-full max-w-[min(420px,calc(100vw-2rem))] sm:max-w-[420px] aspect-[9/16] flex flex-col relative border border-white/80 overflow-hidden rounded-none"
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
            className="text-[2.85rem] leading-[1.02] font-normal text-slate-900 tracking-tight"
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
      <div className="px-4 pb-3 pt-1 flex-1 min-h-0 flex flex-col">{children}</div>
      <footer className="shrink-0 border-t border-slate-200/80 bg-gradient-to-b from-white/95 to-slate-50/90 py-3.5 sm:py-4 px-3 sm:px-5 flex items-center justify-center">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2.5 text-[#4f678f]">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center text-[#4A7FD4]">
              <img src="/app-store.png" alt="App Store" className="w-8 h-8 rounded-[8px] object-cover" />
            </span>
            <span
              className="text-[15px] font-semibold tracking-tight"
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
              className="text-[15px] font-semibold tracking-tight"
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
/** 2.5% of the 0–10 axis → 0.25 score — grid + drag snapping. */
const SCORE_CHART_STEP = 0.25;
const SCORE_PX_PER_UNIT = SVG_VB_WIDTH / SCORE_AXIS_MAX;

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
  /** Sharper bell than N(5, 1.5²): smaller σ → steeper drop toward “Top 10%” tail. */
  const chartOpts = useMemo(() => ({ width: 200, baseline: 58, peakAmp: 44, scoreSd: 1.05 }), []);
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
    const steps = Math.round(1 / SCORE_CHART_STEP);
    return Math.round(Math.max(0, Math.min(SCORE_AXIS_MAX, score)) * steps) / steps;
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
        className="w-full max-w-full mb-1 rounded-[24px] p-5 flex flex-col items-center overflow-hidden border border-slate-200/70 bg-white/82 shadow-[0_6px_18px_rgba(15,23,42,0.05)]"
        style={{ borderRadius: "28px" }}
      >
      <div className={cn("flex justify-center gap-7 w-full shrink-0", !hasSide && "justify-center")}>
        <div className="flex flex-col items-center">
          <HarmonyFacePhoto src={frontPreview} photoId="front" />
          {hasSide && (
            <>
              <div className="text-[1.15rem] font-bold text-[#4A7FD4] mt-2 tabular-nums">{frontScore.toFixed(1)}</div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.14em]">{L.front}</div>
            </>
          )}
        </div>
        {hasSide && (
          <div className="flex flex-col items-center">
            <HarmonyFacePhoto src={sidePreview} photoId="side" />
            <div className="text-[1.15rem] font-bold text-[#4A7FD4] mt-2 tabular-nums">{sideScore.toFixed(1)}</div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-[0.14em]">{L.side}</div>
          </div>
        )}
      </div>
      <div className="shrink-0 text-center mt-4 px-2 max-w-[360px] mx-auto w-full">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 mb-1.5">
          {locale === "de" ? "Harmonie-Score" : "Harmony score"}
        </div>
        <div className="text-[3.8rem] font-black text-slate-900 tabular-nums leading-none tracking-tight">
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
            <div className="text-[13px] font-semibold text-slate-800 tabular-nums leading-tight">{formatRankTopPercent(populationTopPercent, locale)}</div>
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
              {/* Vertical grid: every 0.25 score (2.5% of axis); stronger at integers & half-points. */}
              {Array.from({ length: Math.floor(SCORE_AXIS_MAX / SCORE_CHART_STEP) - 1 }, (_, k) => {
                const s = (k + 1) * SCORE_CHART_STEP;
                const sx = s * SCORE_PX_PER_UNIT;
                const cy = scoreBasedCurveYAtX(sx, chartOpts);
                const isInt = Number.isInteger(s);
                const isHalf = Math.abs(s * 2 - Math.round(s * 2)) < 1e-6 && !isInt;
                const opacity = isInt ? 0.24 : isHalf ? 0.16 : 0.1;
                return (
                  <line
                    key={s}
                    x1={sx}
                    y1={cy - 9}
                    x2={sx}
                    y2={58}
                    stroke={`rgba(130,135,155,${opacity})`}
                    strokeWidth={isInt ? 0.55 : 0.45}
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
      <MetricsPortraitPhoto src={portraitPreview} />
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
