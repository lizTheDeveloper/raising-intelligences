interface Props {
  age: number;
  size?: number;
}

export function ChildPresence({ age, size = 120 }: Props) {
  const ageNorm = Math.min(Math.max(age, 0), 20) / 20;
  const isVeryYoung = age <= 4;

  const headRx = isVeryYoung ? 11 : 9 + ageNorm * 1.5;
  const headRy = isVeryYoung ? 13 : 10 + ageNorm * 2;
  const headCy = isVeryYoung ? 72 : 70 - ageNorm * 5;
  const shoulderW = 14 + ageNorm * 13;
  const glowOpacity = 0.28 - ageNorm * 0.08;

  const gradId = `cp-glow-${age}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      className="child-presence"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={gradId} cx="50%" cy="36%" r="55%">
          <stop offset="0%"   stopColor="#e8b96a" stopOpacity={glowOpacity + 0.12} />
          <stop offset="50%"  stopColor="#e8b96a" stopOpacity={glowOpacity * 0.35} />
          <stop offset="100%" stopColor="#e8b96a" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Warm backlit glow — screen or window behind the figure */}
      <ellipse cx="60" cy="42" rx="46" ry="36" fill={`url(#${gradId})`} />

      {/* Head silhouette */}
      <ellipse
        cx="60"
        cy={headCy}
        rx={headRx}
        ry={headRy}
        fill="#0a0a0a"
        stroke="#c4b99a"
        strokeWidth="0.8"
        opacity="0.7"
      />

      {/* Shoulder arc — grows wider with age */}
      <path
        d={[
          `M ${60 - shoulderW - 5} ${headCy + headRy + 14}`,
          `Q ${60 - shoulderW * 0.55} ${headCy + headRy + 5} 60 ${headCy + headRy + 3}`,
          `Q ${60 + shoulderW * 0.55} ${headCy + headRy + 5} ${60 + shoulderW + 5} ${headCy + headRy + 14}`,
        ].join(' ')}
        fill="none"
        stroke="#c4b99a"
        strokeWidth="1"
        opacity="0.3"
      />
    </svg>
  );
}
