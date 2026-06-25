import { useState, useEffect } from "react";
import { ChildPresence } from "./ChildPresence";
import { track } from "../analytics";

type ChildGender = "boy" | "girl" | "nonbinary";

interface Props {
  age: number;
  size?: number;
  gameId?: string | null;
  gender?: ChildGender;
  onLoad?: () => void;
}

function ageSlug(age: number): string {
  if (age <= 4) return "age-03";
  if (age <= 9) return "age-07";
  if (age <= 14) return "age-12";
  if (age <= 19) return "age-16";
  return "age-20";
}

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const STARTER_POOL_SIZE = 30;

function starterUrl(slug: string, gender: ChildGender, gameId: string): string {
  const base = import.meta.env.BASE_URL;
  const variant = hashCode(gameId) % STARTER_POOL_SIZE;
  return `${base}portraits/starters/${gender}/${slug}/${variant}.png`;
}

export function ChildPortrait({ age, size = 180, gameId, gender = "nonbinary", onLoad }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [starterSrc, setStarterSrc] = useState<string | null>(null);
  const slug = ageSlug(age);

  // Try loading a starter portrait as immediate fallback
  useEffect(() => {
    if (!gameId) return;
    const url = starterUrl(slug, gender, gameId);
    const img = new Image();
    img.onload = () => setStarterSrc(url);
    img.onerror = () => {};
    img.src = url;
  }, [gameId, slug, gender]);

  // Long-poll for the AI-generated portrait
  useEffect(() => {
    if (!gameId) return;

    const base = import.meta.env.BASE_URL;
    let mounted = true;
    const controller = new AbortController();

    setSrc(null);

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
          onLoad?.();
        };
        img.onerror = () => {
          track("portrait_failed", { ageBucket: slug });
          onLoad?.();
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

  const displaySrc = src ?? starterSrc;

  if (!displaySrc) {
    return <ChildPresence age={age} size={size} />;
  }

  return (
    <div className="child-portrait" style={{ width: size, height: size }}>
      <img
        src={displaySrc}
        alt=""
        aria-hidden="true"
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  );
}
