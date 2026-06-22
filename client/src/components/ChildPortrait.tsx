import { useState, useEffect } from "react";
import { ChildPresence } from "./ChildPresence";

interface Props {
  age: number;
  size?: number;
  gameId?: string | null;
}

function ageSlug(age: number): string {
  if (age <= 4) return "age-03";
  if (age <= 9) return "age-07";
  if (age <= 14) return "age-12";
  if (age <= 19) return "age-16";
  return "age-20";
}

export function ChildPortrait({ age, size = 180, gameId }: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId) return;

    const slug = ageSlug(age);
    const url = `/portraits/${gameId}/${slug}.png`;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tryLoad = (attempts = 0) => {
      if (!mounted) return;
      const img = new Image();
      img.onload = () => {
        if (mounted) setSrc(url);
      };
      img.onerror = () => {
        if (mounted && attempts < 12) {
          timer = setTimeout(() => tryLoad(attempts + 1), 2000);
        }
      };
      img.src = url;
    };

    setSrc(null);
    tryLoad();

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [gameId, age]);

  if (!src) {
    return <ChildPresence age={age} size={size} />;
  }

  return (
    <div className="child-portrait" style={{ width: size, height: size }}>
      <img
        src={src}
        alt=""
        aria-hidden="true"
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  );
}
