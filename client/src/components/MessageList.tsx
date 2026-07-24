interface Message {
  sender: string;
  content: string;
  chatType: string;
}

interface PlayerLite {
  slot: string;
  displayName: string;
}

interface Props {
  messages: Message[];
  streamingMessage: string;
  childName: string;
  /** Multiplayer: the players, so each parent message is attributed by name. */
  players?: PlayerLite[];
  /** Multiplayer: the local player's slot — their own messages read "you". */
  mySlot?: string | null;
}

/**
 * Label for a message's sender. Solo (no slot) always reads "you" for the one
 * parent. In multiplayer, the local player is "you" and the other parent is
 * shown by their display name so a two-parent transcript is legible.
 */
function senderLabel(
  sender: string,
  childName: string,
  mySlot: string | null | undefined,
  players: PlayerLite[] | undefined,
): string {
  if (sender === "kid") return childName;
  if (!mySlot) return "you"; // solo — only one parent
  if (sender === mySlot) return "you";
  const other = players?.find((p) => p.slot === sender);
  return other?.displayName?.trim() || "your partner";
}

export function MessageList({ messages, streamingMessage, childName, players, mySlot }: Props) {
  return (
    <div className="message-list">
      {messages.map((msg, i) => (
        <div key={i} className={`message message-${msg.sender}`}>
          <span className="message-sender">
            {senderLabel(msg.sender, childName, mySlot, players)}
          </span>
          <span className="message-content">{msg.content}</span>
        </div>
      ))}
      {streamingMessage && (
        <div className="message message-kid">
          <span className="message-sender">{childName}</span>
          <span className="message-content">{streamingMessage}</span>
        </div>
      )}
    </div>
  );
}
