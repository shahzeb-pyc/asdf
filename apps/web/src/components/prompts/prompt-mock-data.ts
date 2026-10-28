/**
 * MOCK / SAMPLE DATA ONLY — layout placeholders, not a real catalogue.
 *
 * These four entries were written for this preview only, to show the
 * decided B card design (uniform size, fixed preview height). They are
 * NOT copied from any external site, they are NOT real prompts, and
 * their copied counts are layout placeholders only — NOT real usage.
 * They must be replaced by real catalogue data (with real counts)
 * before anything here is presented as a live library.
 *
 * The cards deliberately carry NO master prompt text and NO how-to
 * steps: those live in the dedicated section that opens on card
 * click, which is NOT built yet.
 */
export type MockPromptCard = {
  title: string;
  shortDescription: string;
  tool: string;
  category: string;
  language: string;
  length: string;
  format: string;
  copiedCount: number;
  dateAdded: string;
};

export const MOCK_PROMPT_CARDS: readonly MockPromptCard[] = [
  {
    title: "Puppy first bath",
    shortDescription:
      "A golden puppy's first bath, turned into a warm, funny short that feels real from the first second.",
    tool: "Dola AI",
    category: "Animals",
    language: "English",
    length: "1 min+",
    format: "Vertical reel",
    copiedCount: 128,
    dateAdded: "28 Oct 2026",
  },
  {
    title: "Rainy neon street",
    shortDescription:
      "A lone figure crosses a rain-soaked street as neon signs reflect on wet asphalt.",
    tool: "Veo 3",
    category: "Cinematic",
    language: "English",
    length: "15-30s",
    format: "Horizontal video",
    copiedCount: 210,
    dateAdded: "27 Oct 2026",
  },
  {
    title: "Cat steals the show",
    shortDescription:
      "A cat wanders across a news desk mid-broadcast while the presenter tries not to laugh.",
    tool: "Google Flow",
    category: "Comedy",
    language: "Urdu",
    length: "Under 15s",
    format: "Vertical reel",
    copiedCount: 96,
    dateAdded: "26 Oct 2026",
  },
  {
    title: "Kitchen unboxing in three steps",
    shortDescription:
      "A plain box opens on a clean kitchen table, revealing each item in turn.",
    tool: "Dola AI",
    category: "Unboxing",
    language: "Hindi",
    length: "30s+",
    format: "Horizontal video",
    copiedCount: 74,
    dateAdded: "25 Oct 2026",
  },
];
