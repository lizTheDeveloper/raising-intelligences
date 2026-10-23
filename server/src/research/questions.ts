export type WaitKind = "first" | "post_scene" | "next_scene";
export const WAIT_KINDS: readonly WaitKind[] = ["first", "post_scene", "next_scene"];
export type QuestionKind = "about_you" | "about_moment" | "scale";

export interface Question {
  id: string;
  version: number;
  kind: QuestionKind;
  prompt: string;
  waits: WaitKind[];
  answer:
    | { type: "tap"; options: { value: string; label: string }[] }
    | { type: "text"; maxLength: number };
  /** Validated scales need their licence cleared before they may be shown. */
  licenseCleared?: boolean;
}

export interface StoredAnswer {
  gameId: string;
  sceneIndex: number;
  questionId: string;
  questionVersion: number;
  kind: QuestionKind | "repair";
  answer: unknown;
  skipped: boolean;
  shownAt: number;
  answeredAt: number;
}

// Placeholder copy: gentle second person, in the voice of the processing-screen
// fragments. Every prompt and option label is pending Liz's review.
export const QUESTION_BANK: Question[] = [
  {
    id: "growing_up_climate",
    version: 1,
    kind: "about_you",
    // COPY: pending Liz review
    prompt: "Think back to the house you grew up in. What was the weather like in it?",
    waits: ["first", "next_scene"],
    answer: {
      type: "tap",
      options: [
        // COPY: pending Liz review
        { value: "warm", label: "Warm, mostly" },
        { value: "stormy", label: "Stormy, then clear" },
        { value: "quiet", label: "Quiet, and hard to read" },
        { value: "uneven", label: "It changed without warning" },
      ],
    },
  },
  {
    id: "parenting_opinions",
    version: 1,
    kind: "about_you",
    // COPY: pending Liz review
    prompt: "Who in your life has opinions about how you parent?",
    waits: ["first", "next_scene"],
    answer: {
      type: "tap",
      options: [
        // COPY: pending Liz review
        { value: "family", label: "Family, loudly" },
        { value: "friends", label: "Friends, gently" },
        { value: "strangers", label: "Strangers, everywhere" },
        { value: "inner_voice", label: "Mostly the voice in my own head" },
        { value: "nobody", label: "Hardly anyone" },
      ],
    },
  },
  {
    id: "worry_for_child",
    version: 1,
    kind: "about_you",
    // COPY: pending Liz review
    prompt: "What worries you, for this child? You can say it plainly.",
    waits: ["first", "next_scene"],
    answer: { type: "text", maxLength: 300 },
  },
  {
    id: "child_like_you",
    version: 1,
    kind: "about_you",
    // COPY: pending Liz review
    prompt: "How much is this child like you?",
    waits: ["first", "next_scene"],
    answer: {
      type: "tap",
      options: [
        // COPY: pending Liz review
        { value: "not_at_all", label: "Not at all" },
        { value: "a_little", label: "A little" },
        { value: "quite_a_bit", label: "Quite a bit" },
        { value: "uncannily", label: "Uncannily" },
      ],
    },
  },
  {
    id: "hoped_they_would_take",
    version: 1,
    kind: "about_moment",
    // COPY: pending Liz review
    prompt: "What did you hope they'd take from that?",
    waits: ["post_scene"],
    answer: { type: "text", maxLength: 300 },
  },
];

/** Questions for a wait, in bank order, skipping answered/skipped ids and any
 * scale item whose licence has not been cleared. */
export function selectQuestions(args: {
  wait: WaitKind;
  answeredIds: ReadonlySet<string>;
  limit: number;
  bank?: readonly Question[];
}): Question[] {
  const { wait, answeredIds, limit, bank = QUESTION_BANK } = args;
  return bank
    .filter((q) => q.waits.includes(wait))
    .filter((q) => !answeredIds.has(q.id))
    .filter((q) => q.kind !== "scale" || q.licenseCleared === true)
    .slice(0, Math.max(0, limit));
}
