import type { HostType } from "./types.js";

/**
 * The host and guest-reader terms a person agrees to before their portal
 * opens (spec v3 §9.2–9.3: v1 §9.3 clauses 1–9, v2's changes to clause 4 and
 * clauses 10–11, v3's three guest-reader clauses, and who's responsible for
 * what). The version is what's recorded against the person; change it with
 * any change to the words.
 *
 * Not yet here: the GDPR Art. 26 summary the spec asks for. It needs counsel
 * (OQ-9), so it isn't written by the build.
 */
export const HOST_TERMS_VERSION = "host-terms-2026-11-24.1";

export interface HostTerms {
  version: string;
  sections: Array<{ heading: string; bullets: string[] }>;
}

export function hostTerms(hostType: HostType | null): HostTerms {
  const sections: HostTerms["sections"] = [
    {
      heading: "what you agree to",
      bullets: [
        "only run or help with events for adults, and never invite or knowingly let in anyone under 18.",
        "never pressure anyone to join, to share their game, or to swap handles. never ask an attendee whether they shared, or who they were paired with.",
        "never try to work out who is behind anything RI shows you without a name.",
        "keep anything shared with you confidential. use it only for a conversation with that pair, never for marketing, matchmaking scores or training any model. this includes not passing anything to church leaders, employers, family members or other members of the community, in any form.",
        "tell the studio about safety concerns, and don't act on rumours about reports.",
        "keep RI's wording about data intact, and don't describe how RI handles data differently in your own materials.",
        "publish your own privacy notice for anything you collect yourself (sign-up forms, bookings). RI's notice covers only RI.",
        "accept that the studio can suspend you and close your events.",
        "never combine what you see about the same person across events, never keep notes about attendees from anything RI shows you outside a conversation with that pair, and never use RI to recruit people for paid services.",
        "if you hold authority over attendees, whether someone shares has no effect on how you treat them.",
      ],
    },
    {
      heading: "if you read share codes",
      bullets: [
        "you'll only open codes a pair gives you, and only to talk their game through with them.",
        "you won't ask anyone whether they made a code.",
        "nothing you read goes to your congregation, your clients' files or anyone else.",
      ],
    },
    {
      heading: "who's responsible for what",
      bullets: [
        "the studio that makes RI is responsible for everything inside RI, including your page here. you only ever look at things inside RI, and you get no copy.",
        "you're responsible for anything you collect or note down yourself, outside RI.",
        "as a host you see your meetup's link, its card, its status and, at some levels, a few rough numbers a day after it closes. as a guest reader you see only what a pair gives you. nobody here sees who came, who played with whom, or anyone's game unless that pair gives them a code.",
      ],
    },
  ];
  if (hostType === "events_business") {
    sections[0].bullets.push("RI is a game: don't market it as a matchmaking algorithm or say it matches compatible people. pairing is first come, first served.");
  }
  return { version: HOST_TERMS_VERSION, sections };
}
