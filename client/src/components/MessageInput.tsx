import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

const MAX_MESSAGES = 12;

/**
 * Idle time after the last keystroke before we tell the co-parent we stopped.
 * Short enough that "typing…" doesn't linger over a player who wandered off,
 * long enough that ordinary thinking-mid-sentence doesn't flicker it.
 */
const TYPING_IDLE_MS = 1500;

interface Props {
  onSend: (content: string) => void;
  disabled: boolean;
  /**
   * Remaining messages in the per-scene cap. Omit entirely on chats that do
   * not consume the cap — the debrief conversation between the two parents —
   * and both the dot counter and the cap guard disappear with it.
   */
  messagesRemaining?: number;
  /**
   * Co-parent presence. Called with `true` on the first keystroke of a burst
   * and with `false` once the player has been idle for TYPING_IDLE_MS, on
   * send, on clearing the field, and on unmount. The receiver expires a
   * stale `true` on its own as well (see PARTNER_TYPING_TTL) — a signal that
   * can only be cleared by a second message is the `generating` bug again.
   */
  onTyping?: (typing: boolean) => void;
  /** Render "…is typing" above the input. */
  partnerTyping?: boolean;
  partnerName?: string;
  placeholder?: string;
  /**
   * Grab focus on mount. Right for the family chat, wrong for the debrief:
   * there it pops the mobile keyboard over "later that night / the kids are
   * asleep. it's just you two." before the line has finished fading in (1500ms
   * delay on `.debrief-line-2`). The conversation there is optional; the beat
   * lands first.
   */
  autoFocus?: boolean;
}

export function MessageInput({
  onSend,
  disabled,
  messagesRemaining,
  onTyping,
  partnerTyping,
  partnerName,
  placeholder,
  autoFocus = true,
}: Props) {
  const [text, setText] = useState("");

  // Typing signal. Kept in refs so the debounce never re-renders and the
  // unmount cleanup can't capture a stale callback.
  const typingRef = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;

  const stopTyping = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (typingRef.current) {
      typingRef.current = false;
      onTypingRef.current?.(false);
    }
  }, []);

  // Never leave a "still typing" flag behind on a screen we've left.
  useEffect(() => () => stopTyping(), [stopTyping]);

  const noteTyping = useCallback(
    (value: string) => {
      if (!onTypingRef.current) return;
      if (!value.trim()) {
        stopTyping();
        return;
      }
      if (!typingRef.current) {
        typingRef.current = true;
        onTypingRef.current(true);
      }
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        idleTimer.current = null;
        typingRef.current = false;
        onTypingRef.current?.(false);
      }, TYPING_IDLE_MS);
    },
    [stopTyping]
  );

  // A cap is only enforced when one was given.
  const capped = messagesRemaining !== undefined;
  const remaining = messagesRemaining ?? 0;
  const outOfMessages = capped && remaining <= 0;
  const used = MAX_MESSAGES - remaining;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || disabled || outOfMessages) return;
    onSend(text.trim());
    setText("");
    stopTyping();
  };

  return (
    <div className="message-input-wrap">
      {capped && (
        <div className="message-dots">
          {Array.from({ length: MAX_MESSAGES }, (_, i) => {
            const isUsed = i < used;
            const isUrgent = !isUsed && remaining <= 3 && remaining > 0;
            return (
              <span
                key={i}
                className={`message-dot ${isUsed ? "dot-used" : isUrgent ? "dot-urgent" : "dot-active"}`}
              />
            );
          })}
        </div>
      )}
      {partnerTyping && (
        <p className="typing-indicator dim" role="status" aria-live="polite">
          {(partnerName?.trim() || "your partner") + " is typing…"}
        </p>
      )}
      <form onSubmit={handleSubmit} className="message-input">
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            noteTyping(e.target.value);
          }}
          onBlur={stopTyping}
          placeholder={outOfMessages ? "no more messages this scene" : placeholder ?? ""}
          disabled={disabled || outOfMessages}
          autoFocus={autoFocus}
        />
        <button type="submit" disabled={disabled || !text.trim() || outOfMessages}>
          send
        </button>
      </form>
    </div>
  );
}
