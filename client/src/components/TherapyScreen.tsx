import { useState, type FormEvent } from "react";
import type { TherapyMessage } from "../hooks/useGame";

interface Props {
  messages: TherapyMessage[];
  streamingReply?: string;
  canSend: boolean;
  onSend: (content: string) => void;
  onConclude: () => void;
}

/**
 * Dark Play Plan 3, Rung 2 — an interactive therapy session. Unlike
 * ConsultScreen/CpsScreen this is a live conversation: mirrors Chat.tsx's
 * message-list + input shape, but talks to the therapist (not the kid), and
 * has no per-message cap counter of its own — `canSend` already reflects
 * the THERAPY_TURN_CAP parent-turn limit computed by the caller.
 */
export function TherapyScreen({ messages, streamingReply, canSend, onSend, onConclude }: Props) {
  const [text, setText] = useState("");
  const isStreaming = Boolean(streamingReply);
  const disabled = !canSend || isStreaming;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className="therapy-screen">
      <p className="intervention-label">therapy session</p>
      <div className="message-list">
        {messages.map((msg, i) => (
          <div key={i} className={`message message-${msg.speaker}`}>
            <span className="message-sender">
              {msg.speaker === "therapist" ? "therapist" : "you"}
            </span>
            <span className="message-content">{msg.content}</span>
          </div>
        ))}
        {streamingReply && (
          <div className="message message-therapist">
            <span className="message-sender">therapist</span>
            <span className="message-content">{streamingReply}</span>
          </div>
        )}
      </div>
      <form onSubmit={handleSubmit} className="message-input">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={!canSend ? "this session must be concluded" : ""}
          disabled={disabled}
          autoFocus
        />
        <button type="submit" disabled={disabled || !text.trim()}>
          send
        </button>
      </form>
      <button
        onClick={onConclude}
        disabled={isStreaming}
        className="btn btn-secondary"
        data-testid="btn-therapy-conclude"
      >
        conclude session
      </button>
    </div>
  );
}
