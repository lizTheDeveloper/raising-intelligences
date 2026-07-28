import type { CSSProperties } from "react";

const STUDIO_URL = "https://multiversestudios.xyz";
const COLLABORATOR_URL = "https://www.brynncaputo.com/";

interface Props {
  /** "page" sits at the bottom of a screen; "endgame" fades in with the epilogue. */
  variant?: "page" | "endgame";
  style?: CSSProperties;
}

export function Credits({ variant = "page", style }: Props) {
  return (
    <footer className={`credits credits-${variant}`} style={style}>
      <p className="credits-line">
        brought to you by{" "}
        <a href={STUDIO_URL} target="_blank" rel="noopener noreferrer">
          Multiverse Studios
        </a>{" "}
        and in collaboration with{" "}
        <a href={COLLABORATOR_URL} target="_blank" rel="noopener noreferrer">
          Brynn Caputo
        </a>
      </p>
    </footer>
  );
}
