import { useState, type FormEvent } from "react";

const MAX_MESSAGES = 12;

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

  const used = MAX_MESSAGES - messagesRemaining;

  return (
    <div className="message-input-wrap">
      <div className="message-dots">
        {Array.from({ length: MAX_MESSAGES }, (_, i) => {
          const isUsed = i < used;
          const isUrgent = !isUsed && messagesRemaining <= 3 && messagesRemaining > 0;
          return (
            <span
              key={i}
              className={`message-dot ${isUsed ? "dot-used" : isUrgent ? "dot-urgent" : "dot-active"}`}
            />
          );
        })}
      </div>
      <form onSubmit={handleSubmit} className="message-input">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={messagesRemaining <= 0 ? "no more messages this scene" : ""}
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
    </div>
  );
}
