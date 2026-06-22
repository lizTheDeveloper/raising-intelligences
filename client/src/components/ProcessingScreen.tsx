import { useState, useEffect } from "react";
import { ChildPresence } from "./ChildPresence";

const FRAGMENTS = [
  "they made a friend",
  "a small hurt, a quick heal",
  "they stayed up too late",
  "their voice changed",
  "they thought about what you said",
  "the world touched them",
  "they forgot something important",
  "they're still becoming",
];

interface Props {
  childName: string;
  age?: number;
}

export function ProcessingScreen({ childName, age = 6 }: Props) {
  const [fragmentIdx, setFragmentIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFragmentIdx((i) => (i + 1) % FRAGMENTS.length);
    }, 2400);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="processing-screen">
      <div className="processing-figure">
        <ChildPresence age={age} size={110} />
      </div>
      <p className="processing-name">{childName}</p>
      <div className="processing-fragment-area">
        <span key={fragmentIdx} className="processing-fragment-text">
          {FRAGMENTS[fragmentIdx]}
        </span>
      </div>
    </div>
  );
}
