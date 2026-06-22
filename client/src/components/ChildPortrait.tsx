import { useState } from "react";
import { ChildPresence } from "./ChildPresence";

interface Props {
  age: number;
  size?: number;
}

function portraitUrl(age: number): string {
  if (age <= 4)  return "/portraits/age-03.png";
  if (age <= 9)  return "/portraits/age-07.png";
  if (age <= 14) return "/portraits/age-12.png";
  return "/portraits/age-16.png";
}

export function ChildPortrait({ age, size = 180 }: Props) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <ChildPresence age={age} size={size} />;
  }

  return (
    <div className="child-portrait" style={{ width: size, height: size }}>
      <img
        src={portraitUrl(age)}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  );
}
