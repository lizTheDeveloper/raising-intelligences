import { useState, useEffect } from "react";
import { PartnerCards } from "./PartnerCards";
import { KidsList } from "./KidsList";
import { Scrapbook } from "./Scrapbook";
import "../styles/album.css";

const API = import.meta.env.BASE_URL + "api";

export interface AlbumKid {
  gameId: string;
  childName: string;
  createdAt: number;
}

export interface AlbumPartner {
  id: string;
  partnerName: string;
  partnerType: "real" | "generated";
  relationshipSummary: string;
}

interface AlbumData {
  partners: Array<AlbumPartner & { kids: AlbumKid[] }>;
  unlinkedKids: AlbumKid[];
}

type AlbumView = "partners" | "kids" | "scrapbook";

interface Props {
  userId: string;
  onBack: () => void;
}

export function FamilyAlbum({ userId, onBack }: Props) {
  const [view, setView] = useState<AlbumView>("partners");
  const [album, setAlbum] = useState<AlbumData | null>(null);
  const [selectedPartnerId, setSelectedPartnerId] = useState<string | null>(null);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/user/${encodeURIComponent(userId)}/album`)
      .then((r) => r.json())
      .then((data: AlbumData) => {
        setAlbum(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [userId]);

  if (loading) {
    return (
      <div className="album">
        <p className="dim">loading your family...</p>
      </div>
    );
  }

  if (view === "scrapbook" && selectedGameId) {
    return (
      <div className="album">
        <Scrapbook
          userId={userId}
          gameId={selectedGameId}
          onBack={() => {
            setSelectedGameId(null);
            setView(selectedPartnerId ? "kids" : "partners");
          }}
        />
      </div>
    );
  }

  if (view === "kids" && selectedPartnerId && album) {
    const partner = album.partners.find((p) => p.id === selectedPartnerId);
    if (!partner) {
      setView("partners");
      return null;
    }
    return (
      <div className="album">
        <KidsList
          partner={partner}
          kids={partner.kids}
          onSelectKid={(gameId) => {
            setSelectedGameId(gameId);
            setView("scrapbook");
          }}
          onBack={() => {
            setSelectedPartnerId(null);
            setView("partners");
          }}
        />
      </div>
    );
  }

  return (
    <div className="album">
      <div className="album-header">
        <button className="album-back" onClick={onBack}>&larr;</button>
        <h2>my family</h2>
      </div>
      {album && (
        <PartnerCards
          partners={album.partners}
          unlinkedKids={album.unlinkedKids}
          onSelectPartner={(id) => {
            setSelectedPartnerId(id);
            setView("kids");
          }}
          onSelectKid={(gameId) => {
            setSelectedGameId(gameId);
            setView("scrapbook");
          }}
        />
      )}
    </div>
  );
}
