/** Font preload for Image Create DOM export (Instrument Serif + Plus Jakarta Sans). */

export type MetricRow = {
  label: string;
  value: string;
  percent: number;
  tone?: "blue" | "green" | "amber" | "rose";
};

const FONT_SERIF = '"Instrument Serif", Georgia, "Times New Roman", serif';
const FONT_SANS = '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif';

export async function preloadShareCardFonts(): Promise<void> {
  if (typeof document === "undefined") return;
  await document.fonts.ready;
  const specs = [
    `400 64px ${FONT_SERIF}`,
    `400 40px ${FONT_SERIF}`,
    `600 24px ${FONT_SANS}`,
    `600 20px ${FONT_SANS}`,
    `700 28px ${FONT_SANS}`,
    `800 88px ${FONT_SANS}`,
    `600 11px ${FONT_SANS}`,
    `700 13px ${FONT_SANS}`,
  ];
  await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => undefined)));
}
