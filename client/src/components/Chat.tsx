import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";

interface Message {
  sender: string;
  content: string;
  chatType: string;
}

interface Props {
  messages: Message[];
  streamingMessage: string;
  childName: string;
  messagesRemaining: number;
  isStreaming: boolean;
  onSend: (content: string) => void;
  onEndChat: () => void;
}

export function Chat({
  messages,
  streamingMessage,
  childName,
  messagesRemaining,
  isStreaming,
  onSend,
  onEndChat,
}: Props) {
  return (
    <div className="chat">
      <MessageList
        messages={messages}
        streamingMessage={streamingMessage}
        childName={childName}
      />
      <MessageInput
        onSend={onSend}
        disabled={isStreaming}
        messagesRemaining={messagesRemaining}
      />
      <button onClick={onEndChat} disabled={isStreaming} className="btn btn-secondary">
        end conversation
      </button>
    </div>
  );
}
