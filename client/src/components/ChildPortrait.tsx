import { useState, useEffect } from "react";
import { ChildPresence } from "./ChildPresence";

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
    const url = `/portraits/${gameId}/${slug}.png`;
    const fallbackUrl = `/portraits/${slug}.png`;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Guard so onLoad fires at most once per effect lifecycle, regardless of
    // which image path resolves first (custom portrait vs. fallback).
    let loadNotified = false;

    const notifyLoad = () => {
      if (!loadNotified) {
        loadNotified = true;
        onLoad?.();
      }
    };

    const tryLoadFallback = () => {
      if (!mounted) return;
      const img = new Image();
      img.onload = () => {
        if (!mounted) return;
        // Only switch to the fallback if the custom portrait hasn't loaded yet.
        // NOTE: onLoad must NOT be called inside the setSrc updater — doing so
        // would trigger a GuardianScreen state update during ChildPortrait's
        // render cycle (React "Cannot update a component while rendering" error).
        setSrc((currentSrc) => (currentSrc === url ? currentSrc : fallbackUrl));
        notifyLoad();
      };
      img.onerror = () => {
        if (mounted) notifyLoad();
      };
      img.src = fallbackUrl;
    };

    const tryLoad = (attempts = 0) => {
      if (!mounted) return;
      const img = new Image();
      img.onload = () => {
        if (mounted) {
          setSrc(url);
          notifyLoad();
        }
      };
      img.onerror = () => {
        if (!mounted) return;
        // On first failure, immediately try the fallback so the player isn't blocked.
        if (attempts === 0) tryLoadFallback();
        if (attempts < 12) {
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
