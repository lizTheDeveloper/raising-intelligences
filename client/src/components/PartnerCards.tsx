import type { AlbumPartner, AlbumKid } from "./FamilyAlbum";

interface Props {
  partners: Array<AlbumPartner & { kids: AlbumKid[] }>;
  unlinkedKids: AlbumKid[];
  onSelectPartner: (partnerId: string) => void;
  onSelectKid: (gameId: string) => void;
}

export function PartnerCards({ partners, unlinkedKids, onSelectPartner, onSelectKid }: Props) {
  if (partners.length === 0 && unlinkedKids.length === 0) {
    return (
      <div className="album-empty">
        <p>no kids yet.</p>
        <p className="dim">play a game to start your family album.</p>
      </div>
    );
  }

  return (
    <div className="partner-grid">
      {partners.map((p) => (
        <div key={p.id} className="partner-card" onClick={() => onSelectPartner(p.id)}>
          <p className={`partner-name${p.partnerType === "generated" ? " partner-generated" : ""}`}>
            {p.partnerName}
          </p>
          <p className="partner-kid-count">
            {p.kids.length} {p.kids.length === 1 ? "kid" : "kids"}
          </p>
        </div>
      ))}
      {unlinkedKids.length > 0 && (
        <div className="partner-card">
          <p className="partner-name partner-generated">earlier kids</p>
          <p className="partner-kid-count">{unlinkedKids.length}</p>
          <div className="kids-list" style={{ marginTop: "0.5rem" }}>
            {unlinkedKids.map((kid) => (
              <div key={kid.gameId} className="kid-card" onClick={() => onSelectKid(kid.gameId)}>
                <p className="kid-name">{kid.childName}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
