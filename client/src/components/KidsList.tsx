import type { AlbumPartner, AlbumKid } from "./FamilyAlbum";

interface Props {
  partner: AlbumPartner;
  kids: AlbumKid[];
  onSelectKid: (gameId: string) => void;
  onBack: () => void;
}

export function KidsList({ partner, kids, onSelectKid, onBack }: Props) {
  return (
    <div>
      <div className="album-header">
        <button className="album-back" onClick={onBack}>&larr;</button>
        <h2 className={partner.partnerType === "generated" ? "partner-generated" : ""}>
          kids with {partner.partnerName}
        </h2>
      </div>
      {partner.relationshipSummary && (
        <p className="dim" style={{ marginBottom: "1rem" }}>{partner.relationshipSummary}</p>
      )}
      <div className="kids-list">
        {kids.map((kid) => (
          <div key={kid.gameId} className="kid-card" onClick={() => onSelectKid(kid.gameId)}>
            <p className="kid-name">{kid.childName}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
