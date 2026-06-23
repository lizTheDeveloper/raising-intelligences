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
  const slug = ageSlug(age);

  useEffect(() => {
    if (!gameId) return;

    const base = import.meta.env.BASE_URL;
    let mounted = true;
    const controller = new AbortController();

    setSrc(null);

    // One request — server holds it open until the file exists, then responds.
    fetch(`${base}api/game/${gameId}/portraits/${slug}/await`, { signal: controller.signal })
      .then((res) => {
        if (!mounted) return;
        if (!res.ok) { track("portrait_failed", { ageBucket: slug }); onLoad?.(); return; }
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
          }
          // Always notify parent even if this effect's cleanup already ran
          // (age-bucket change can cause cleanup before img.onload fires).
          onLoad?.();
        };
        img.onerror = () => {
          track("portrait_failed", { ageBucket: slug });
          onLoad?.(); // unblock parent even if image load fails
        };
        img.src = url;
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        if (mounted) {
          track("portrait_failed", { ageBucket: slug });
          onLoad?.();
        }
      });

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [gameId, slug]);

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
