import { useState, useEffect } from "react";
import { ReportCard } from "./ReportCard";

const API = import.meta.env.BASE_URL + "api";
const BASE = import.meta.env.BASE_URL;

interface Portrait {
  age: number;
  url: string;
}

interface Moment {
  age: number;
  title: string;
  description: string;
  momentType: string;
  imageUrl: string | null;
}

interface ScrapbookData {
  childName: string;
  partnerName: string | null;
  partnerType: string | null;
  relationshipSummary: string | null;
  portraits: Portrait[];
  moments: Moment[];
  epilogue: string;
  reportCard: string;
}

interface Props {
  userId: string;
  gameId: string;
  onBack: () => void;
}

export function Scrapbook({ userId, gameId, onBack }: Props) {
  const [data, setData] = useState<ScrapbookData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/user/${encodeURIComponent(userId)}/album/kid/${gameId}`)
      .then((r) => r.json())
      .then((d: any) => {
        setData({
          ...d,
          moments: (d.moments ?? []).map((m: any) => ({
            ...m,
            imageUrl: m.imagePath ? `${BASE}${m.imagePath}` : null,
          })),
          portraits: (d.portraits ?? []).map((p: any) => ({
            ...p,
            url: `${BASE}${p.url}`,
          })),
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [userId, gameId]);

  if (loading) return <p className="dim">loading scrapbook...</p>;
  if (!data) return <p className="dim">not found</p>;

  return (
    <div>
      <div className="album-header">
        <button className="album-back" onClick={onBack}>&larr;</button>
        <div>
          <h2 style={{ margin: 0 }}>{data.childName}</h2>
          {data.partnerName && (
            <p className="dim" style={{ margin: 0, fontSize: "0.85rem" }}>
              with {data.partnerName}
            </p>
          )}
        </div>
      </div>

      {data.portraits.length > 0 && (
        <div className="scrapbook-portraits">
          {data.portraits.map((p) => (
            <div key={p.age} className="scrapbook-portrait">
              <img src={p.url} alt={`age ${p.age}`} />
              <div className="scrapbook-portrait-label">age {p.age}</div>
            </div>
          ))}
        </div>
      )}

      {data.moments.length > 0 && (
        <div className="scrapbook-section">
          <h3>key moments</h3>
          <div className="scrapbook-moments">
            {data.moments.map((m, i) => (
              <div key={i} className="moment-card">
                {m.imageUrl ? (
                  <img src={m.imageUrl} alt="" className="moment-image" />
                ) : (
                  <div className="moment-placeholder" />
                )}
                <div className="moment-body">
                  <p className="moment-title">
                    <span className="moment-age-badge">age {m.age}</span>
                    {m.title}
                    <span className={`moment-type moment-type-${m.momentType}`}> {m.momentType}</span>
                  </p>
                  <p className="moment-desc">{m.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.epilogue && (
        <div className="scrapbook-section">
          <h3>years later</h3>
          {data.epilogue
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((para, i) => (
              <p key={i} style={{ color: "var(--text-dim, #ccc)" }}>{para}</p>
            ))}
        </div>
      )}

      {data.reportCard && (
        <div className="scrapbook-section">
          <h3>report card</h3>
          <ReportCard reportCard={data.reportCard} childName={data.childName} />
        </div>
      )}
    </div>
  );
}
