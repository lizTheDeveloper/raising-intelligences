import { useState, type FormEvent } from "react";

interface Props {
  onSend: (content: string) => void;
  disabled: boolean;
  messagesRemaining: number;
}

export function MessageInput({ onSend, disabled, messagesRemaining }: Props) {
  const [text, setText] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <form onSubmit={handleSubmit} className="message-input">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          messagesRemaining <= 0
            ? "no more messages this scene"
            : `${messagesRemaining} messages left`
        }
        disabled={disabled || messagesRemaining <= 0}
        autoFocus
      />
      <button
        type="submit"
        disabled={disabled || !text.trim() || messagesRemaining <= 0}
      >
        send
      </button>
    </form>
  );
}
