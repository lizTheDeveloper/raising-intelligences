// Mirrors server/src/research/questions.ts. Only the fields the client reads;
// the server's `licenseCleared` gate is resolved before a question is sent.

export type WaitKind = "first" | "post_scene" | "next_scene";
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
}
