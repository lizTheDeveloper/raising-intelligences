import { useState, useEffect } from "react";
import { ChildPresence } from "./ChildPresence";
import { track } from "../analytics";

interface Props {
  age: number;
  size?: number;
  gameId?: string | null;
  onLoad?: () => void;
}

function ageSlug(age: number): string {
  if (age <= 4) return "age-03";
  if (age <= 9) return "age-07";
  if (age <= 14) return "age-12";
  if (age <= 19) return "age-16";
  return "age-20";
}

export function ChildPortrait({ age, size = 180, gameId, onLoad }: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!gameId) return;

    const slug = ageSlug(age);
    const base = import.meta.env.BASE_URL;
    let mounted = true;
    const controller = new AbortController();

    setSrc(null);

    // One request — server holds it open until the file exists, then responds.
    fetch(`${base}api/game/${gameId}/portraits/${slug}/await`, { signal: controller.signal })
      .then((res) => {
        if (!mounted || !res.ok) return;
        return res.json();
      })
      .then((data: { url?: string } | undefined) => {
        if (!mounted || !data?.url) return;
        const url = `${base}${data.url}`;
        const img = new Image();
        img.onload = () => {
          if (mounted) {
            setSrc(url);
            track("portrait_loaded", { ageBucket: slug, attempts: 0 });
            onLoad?.();
          }
        };
        img.onerror = () => {
          if (mounted) {
            track("portrait_failed", { ageBucket: slug });
            onLoad?.(); // unblock GuardianScreen even if image load fails
          }
        };
        img.src = url;
      })
      .catch(() => {
        if (mounted) track("portrait_failed", { ageBucket: slug });
      });

    return () => {
      mounted = false;
      controller.abort();
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
