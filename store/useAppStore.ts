import { create } from 'zustand';

export type Gender = 'male' | 'female';
export type Screen = 'welcome' | 'upload' | 'editor' | 'results' | 'template' | 'history' | 'imageCreate';
export type ResultTab = 'front' | 'side';
export type SortOrder = 'default' | 'score_desc' | 'score_asc';

export interface Ratio {
  id: string;
  name: string;
  category: string;
  profile: string;
  value: number;
  idealMin: number;
  idealMax: number;
  weight: number;
  maxRawScore: number;
  unit: string;
  score: number;
  formattedValue: string;
}

export interface AnalysisResult {
  ratios: Ratio[];
  harmonyScore: number;
  percentile: number;
  percentileLabel: string;
}

export interface Point {
  x: number;
  y: number;
  z?: number;
}

interface AppState {
  // Navigation
  screen: Screen;
  setScreen: (s: Screen) => void;

  // Gender
  gender: Gender | null;
  setGender: (g: Gender) => void;

  // Images
  frontImageUrl: string | null;
  sideImageUrl: string | null;
  sideFlippedUrl: string | null;
  frontImageObj: HTMLImageElement | null;
  sideImageObj: HTMLImageElement | null;
  setFrontImage: (url: string, img: HTMLImageElement) => void;
  setSideImage: (url: string, img: HTMLImageElement) => void;
  setSideFlippedUrl: (url: string) => void;

  // Landmarks
  frontLandmarks: Point[] | null;
  sideLandmarkDict: Record<string, Point> | null;
  frontPlacedSet: Record<number, boolean>;
  setFrontLandmarks: (lm: Point[]) => void;
  setSideLandmarkDict: (d: Record<string, Point>) => void;
  setFrontPlacedSet: (s: Record<number, boolean>) => void;

  // Editor
  editorPhase: 'front' | 'side';
  currentLmIndex: number;
  currentZoom: number;
  sideFlipped: boolean;
  setEditorPhase: (p: 'front' | 'side') => void;
  setCurrentLmIndex: (i: number) => void;
  setCurrentZoom: (z: number) => void;
  setSideFlipped: (f: boolean) => void;

  // Results
  frontResult: AnalysisResult | null;
  sideResult: AnalysisResult | null;
  resultsSavedToHistory: boolean;
  historySaveFingerprint: string | null;
  currentResultTab: ResultTab;
  currentSortOrder: SortOrder;
  highlightedRatioId: string | null;
  setFrontResult: (r: AnalysisResult) => void;
  setSideResult: (r: AnalysisResult) => void;
  setResultsSaved: (v: boolean) => void;
  setHistorySaveFingerprint: (v: string | null) => void;
  setCurrentResultTab: (t: ResultTab) => void;
  toggleSort: () => void;
  setHighlightedRatioId: (id: string | null) => void;

  // Reset
  resetAll: () => void;
}

const initialState = {
  screen: 'welcome' as Screen,
  gender: null as Gender | null,
  frontImageUrl: null as string | null,
  sideImageUrl: null as string | null,
  sideFlippedUrl: null as string | null,
  frontImageObj: null as HTMLImageElement | null,
  sideImageObj: null as HTMLImageElement | null,
  frontLandmarks: null as Point[] | null,
  sideLandmarkDict: null as Record<string, Point> | null,
  frontPlacedSet: {} as Record<number, boolean>,
  editorPhase: 'front' as 'front' | 'side',
  currentLmIndex: 0,
  currentZoom: 2,
  sideFlipped: false,
  frontResult: null as AnalysisResult | null,
  sideResult: null as AnalysisResult | null,
  resultsSavedToHistory: false,
  historySaveFingerprint: null,
  currentResultTab: 'front' as ResultTab,
  currentSortOrder: 'default' as SortOrder,
  highlightedRatioId: null as string | null,
};

export const useAppStore = create<AppState>((set) => ({
  ...initialState,

  setScreen: (s) => set({ screen: s }),
  setGender: (g) => set({ gender: g }),
  setFrontImage: (url, img) => set({ frontImageUrl: url, frontImageObj: img }),
  setSideImage: (url, img) => set({ sideImageUrl: url, sideImageObj: img }),
  setSideFlippedUrl: (url) => set({ sideFlippedUrl: url }),
  setFrontLandmarks: (lm) => set({ frontLandmarks: lm }),
  setSideLandmarkDict: (d) => set({ sideLandmarkDict: d }),
  setFrontPlacedSet: (s) => set({ frontPlacedSet: s }),
  setEditorPhase: (p) => set({ editorPhase: p }),
  setCurrentLmIndex: (i) => set({ currentLmIndex: i }),
  setCurrentZoom: (z) => set({ currentZoom: z }),
  setSideFlipped: (f) => set({ sideFlipped: f }),
  setFrontResult: (r) => set({ frontResult: r, resultsSavedToHistory: false }),
  setSideResult: (r) => set({ sideResult: r }),
  setResultsSaved: (v) => set({ resultsSavedToHistory: v }),
  setHistorySaveFingerprint: (v) => set({ historySaveFingerprint: v }),
  setCurrentResultTab: (t) => set({ currentResultTab: t }),
  toggleSort: () => set((s) => ({
    currentSortOrder: s.currentSortOrder === 'default' ? 'score_desc'
      : s.currentSortOrder === 'score_desc' ? 'score_asc' : 'default'
  })),
  setHighlightedRatioId: (id) => set({ highlightedRatioId: id }),

  resetAll: () => set({ ...initialState }),
}));
