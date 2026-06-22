interface Message {
  sender: string;
  content: string;
  chatType: string;
}

interface Props {
  messages: Message[];
  streamingMessage: string;
  childName: string;
}

export function MessageList({ messages, streamingMessage, childName }: Props) {
  return (
    <div className="message-list">
      {messages.map((msg, i) => (
        <div key={i} className={`message message-${msg.sender}`}>
          <span className="message-sender">
            {msg.sender === "kid" ? childName : "you"}
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
