import { useState, useEffect, useRef, useCallback } from "react";
import { useMultiplayer, clearResume } from "../hooks/useMultiplayer";
import { getSavedKids, saveKid, syncKidsToServer, fetchServerKids, mergeKids, THERAPY_TURN_CAP } from "../hooks/useGame";
import type { SavedKid } from "../hooks/useGame";
import { track } from "../analytics";
import { Lobby } from "./Lobby";
import { GuardianScreen } from "./GuardianScreen";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";
import { ConsultScreen } from "./ConsultScreen";
import { TherapyScreen } from "./TherapyScreen";
import { CpsScreen } from "./CpsScreen";
import { Endgame } from "./Endgame";
import { ReportCard } from "./ReportCard";
import { ProcessingScreen } from "./ProcessingScreen";
import { ChildPortrait } from "./ChildPortrait";
import { FamilyAlbum } from "./FamilyAlbum";

const RELATIONSHIP_OPTIONS = [
  "romantic partners",
  "friends",
  "siblings",
  "ex-partners",
  "co-parents who were never together",
];

interface Props {
  /** Present when the page was opened from an invite link (?game=...). */
  joinGameId?: string;
  /** Display name from Matrix login, pre-fills the name field. */
  matrixDisplayName?: string;
}

export function MultiplayerGame({ joinGameId, matrixDisplayName }: Props) {
  const mp = useMultiplayer();
  const [nameInput, setNameInput] = useState(matrixDisplayName ?? "");
  const [childInput, setChildInput] = useState("");
  const [relationship, setRelationship] = useState(RELATIONSHIP_OPTIONS[0]);
  const [guardianDismissed, setGuardianDismissed] = useState(false);
  const autoResumeAttempted = useRef(false);

  // "Previous kids" — mirror the solo flow so a two-parent player can see and
  // reopen the children they've raised, both in this browser and (when logged
  // in) across devices via the family album.
  const [matrixUser, setMatrixUser] = useState<string | null>(
    () => window.matrixAuth?.getUserId() ?? null
  );
  const [cloudKids, setCloudKids] = useState<SavedKid[]>([]);
  const [showAlbum, setShowAlbum] = useState(false);
  const savedKidRef = useRef<string | null>(null);

  // On mount, if we have resume data in localStorage, connect the socket
  // to trigger auto-rejoin (the connect handler in useMultiplayer does the rest).
  useEffect(() => {
    if (autoResumeAttempted.current) return;
    autoResumeAttempted.current = true;
    const raw = localStorage.getItem("ri_resume");
    if (raw) {
      mp.ensureSocket();
    }
  }, [mp]);

  const syncOnLogin = useCallback(async (userId: string) => {
    setMatrixUser(userId);
    await syncKidsToServer(userId);
    const remote = await fetchServerKids(userId);
    setCloudKids(mergeKids(getSavedKids(), remote));
  }, []);

  // Pick up Matrix login the same way SoloGame does, so the album/kids follow
  // the signed-in user.
  useEffect(() => {
    const onReady = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.loggedIn && detail?.userId) syncOnLogin(detail.userId);
    };
    const onLogin = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.userId) syncOnLogin(detail.userId);
    };
    window.addEventListener("matrixAuthReady", onReady);
    window.addEventListener("matrixAuthLogin", onLogin);
    return () => {
      window.removeEventListener("matrixAuthReady", onReady);
      window.removeEventListener("matrixAuthLogin", onLogin);
    };
  }, [syncOnLogin]);

  // Record the child once we know both the gameId and its name — for both the
  // creator and the joining partner. Solo does this in useGame.createGame; the
  // multiplayer flow never did, which is why previous kids weren't showing.
  useEffect(() => {
    const gid = mp.gameId;
    const childName = mp.state?.childName;
    if (!gid || !childName || savedKidRef.current === gid) return;
    savedKidRef.current = gid;
    saveKid(gid, childName);
    if (matrixUser) syncKidsToServer(matrixUser).catch(() => {});
  }, [mp.gameId, mp.state?.childName, matrixUser]);

  const state = mp.state;
  const mySlot = mp.slot;
  const sidebarActive = state?.sidebarActive ?? null;
  const inMySidebar = sidebarActive !== null && sidebarActive === mySlot;
  const inOtherSidebar = sidebarActive !== null && sidebarActive !== mySlot;

  // Guardian screen: show on the first event intro (eventNumber === 1, event loaded).
  // Derived from state so reconnects to later phases skip it correctly.
  const inLobbyView = !state || (state.phase === "event_intro" && state.currentEventNumber === 0);
  // Not gated on `event_intro`: one ready gate now carries the pair straight
  // from the lobby into `family_chat`, so requiring that phase would skip the
  // guardian intro entirely. It's a local, per-player overlay — dismissing it
  // doesn't touch shared state.
  const showGuardian =
    !guardianDismissed &&
    !!state &&
    (state.phase === "event_intro" || state.phase === "family_chat") &&
    state.currentEventNumber === 1 &&
    state.currentEvent !== null;

  /**
   * Am *I* readied — according to the server.
   *
   * This is the only ready flag in this component, and it is derived, not
   * stored. It used to be two pieces of local React state (`gateReady` and
   * `ladderReady`) resynced by effects keyed on `currentEventNumber` /
   * `phase`, and that is what deadlocked live games: the server clears every
   * player's ready flag via `resetReady()` on *each* successful advance, but
   * `END_DEBRIEF` moves debrief → event_intro without touching
   * `currentEventNumber`, so the reset effect never fired. The client kept
   * rendering "you're ready" on a gate the server had already reset, the
   * player never sent `ready(true)` again, and the pair sat on "1 of 2
   * ready" forever.
   *
   * `mp.players` is refreshed by the LOBBY broadcast that follows every
   * `setReady` *and* every `resetReady` — including on reconnect and join —
   * so reading from it can't drift by construction. Lobby.tsx has always
   * done exactly this. There is deliberately no optimistic local override:
   * re-introducing one re-introduces the deadlock.
   */
  const meReady = mp.players.find((p) => p.slot === mySlot)?.ready ?? false;
  const partnerName =
    mp.players.find((p) => p.slot !== mySlot)?.displayName?.trim() || "your partner";

  // ---- Family album (logged-in): browse previously-raised children ----
  if (showAlbum && matrixUser) {
    return (
      <div className="app">
        <FamilyAlbum userId={matrixUser} onBack={() => setShowAlbum(false)} />
      </div>
    );
  }

  // Previous kids to offer on the setup screen: server-backed when signed in,
  // otherwise this browser's local history.
  const galleryKids = cloudKids.length > 0 ? cloudKids : getSavedKids();

  // ---- Setup: create or join ----
  if (!mp.gameId) {
    return (
      <div className="app">
        <div className="start-screen">
          <div className="start-glow" aria-hidden="true" />
          <h1>raising intelligences</h1>
          {mp.error && <p className="error">{mp.error}</p>}
          {joinGameId ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (nameInput.trim()) mp.joinGame(joinGameId, nameInput.trim());
              }}
            >
              <p className="dim">your name</p>
              <input
                className="name-input"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                autoFocus
              />
              <button className="btn" type="submit" disabled={!nameInput.trim()}>
                join
              </button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (childInput.trim() && nameInput.trim())
                  mp.createGame(childInput.trim(), relationship, nameInput.trim());
              }}
            >
              <p className="dim">name your child</p>
              <input
                className="name-input"
                value={childInput}
                onChange={(e) => setChildInput(e.target.value)}
                autoFocus
              />
              <p className="dim" style={{ marginTop: 24 }}>your name</p>
              <input
                className="name-input"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
              />
              <p className="dim" style={{ marginTop: 24 }}>your child-rearing partner</p>
              <select
                className="relationship-select"
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
              >
                {RELATIONSHIP_OPTIONS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
              <button
                className="btn"
                type="submit"
                disabled={!childInput.trim() || !nameInput.trim()}
              >
                create game
              </button>
            </form>
          )}

          {!joinGameId && galleryKids.length > 0 && (
            <div className="saved-kids">
              <p className="dim">or return to...</p>
              {galleryKids.map((kid) => (
                <button
                  key={kid.gameId}
                  className="btn btn-secondary saved-kid-btn"
                  onClick={() => {
                    const url = new URL(window.location.href);
                    url.searchParams.set("game", kid.gameId);
                    window.location.href = url.toString();
                  }}
                >
                  {kid.childName}
                </button>
              ))}
            </div>
          )}

          {!joinGameId && matrixUser && (
            <button
              className="btn btn-secondary"
              style={{ marginTop: "1rem" }}
              onClick={() => setShowAlbum(true)}
            >
              family album
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- Lobby: first event_intro, before the story begins ----
  if (inLobbyView) {
    return (
      <div className="app fade-in">
        <Lobby
          gameId={mp.gameId}
          slot={mySlot}
          players={mp.players}
          childName={state?.childName ?? childInput}
          error={mp.error}
          generating={mp.generating}
          onReady={mp.ready}
          onLeave={mp.leaveGame}
        />
      </div>
    );
  }

  // ---- Guardian: personality quiz before the first event ----
  if (showGuardian) {
    return (
      <div className="app fade-in">
        <GuardianScreen
          childName={state.childName}
          gameId={mp.gameId}
          eventReady={state.currentEvent !== null}
          onReady={() => setGuardianDismissed(true)}
          onSubmitPersonality={mp.submitPersonality}
          seedReadyProp={mp.seedReady}
        />
      </div>
    );
  }

  // ---- Between chapters: one ready gate straight into the next chapter ----
  if (state.phase === "event_intro") {
    return (
      <div className="app fade-in">
        {/* One chain, not two independent ternaries. The scene description
            and the progress line used to be rendered by separate conditions,
            so a non-null `currentEvent` put the PREVIOUS scene's setup
            underneath "building the next scene…". While we're generating,
            there is no scene to show. */}
        <div className="event-intro">
          {mp.generating ? (
            <p className="dim" role="status" aria-live="polite">
              building the next scene…
            </p>
          ) : state.currentEvent ? (
            <>
              <p className="age-marker">— age {state.currentEvent.age} —</p>
              <p className="event-description">{state.currentEvent.description}</p>
              <ReadyToggle
                ready={meReady}
                onToggle={mp.ready}
                label="ready to begin"
                players={mp.players}
              />
            </>
          ) : (
            <>
              <p className="dim">the story continues…</p>
              <ReadyToggle
                ready={meReady}
                onToggle={mp.ready}
                label="ready for the next chapter"
                players={mp.players}
              />
            </>
          )}
        </div>
      </div>
    );
  }

  // ---- Family chat / sidebar / adult chat ----
  if (state.phase === "family_chat" || state.phase === "sidebar" || state.phase === "adult_chat") {
    const inputDisabled = mp.isStreaming || inOtherSidebar || mp.sceneEnding;
    // Per-scene transcript. `state.messages` is cumulative for the whole game,
    // so without this the previous scene's conversation renders underneath the
    // new scene's header. Every message is stamped with the event it belongs
    // to server-side; the play screen just never read it. Debrief messages are
    // the parents alone at night — they belong to the debrief screen, not
    // here, and (unlike the family chat) they don't consume the scene cap.
    //
    // Deliberately NOT applied to adult_chat: START_ADULT_CHAT leaves
    // `currentEventNumber` at the final scene's value, so adult-chat messages
    // share it with the last childhood scene and there is no client-side
    // discriminator between them. Filtering there would reintroduce the bug.
    const sceneMessages =
      state.phase === "adult_chat"
        ? state.messages
        : state.messages.filter(
            (m) => m.eventNumber === state.currentEventNumber && m.chatType !== "debrief"
          );
    return (
      <div className="app fade-in">
        <div className="chat-portrait-header">
          <ChildPortrait
            age={state.phase === "adult_chat" ? 22 : (state.currentEvent?.age ?? 3)}
            size={64}
            gameId={mp.gameId}
            gender={state.childGender}
          />
          <p className="age-marker">
            {state.phase === "adult_chat" ? "— adulthood —" : `— age ${state.currentEvent?.age} —`}
            {state.currentEventNumber > 0 && state.phase !== "adult_chat" && (
              <span className="event-count"> · {state.currentEventNumber} of {state.totalEvents}</span>
            )}
          </p>
        </div>

        {state.currentEvent?.description && state.phase !== "adult_chat" && (
          <p className="event-context">{state.currentEvent.description}</p>
        )}

        {inMySidebar && <p className="sidebar-banner">private conversation</p>}
        {inOtherSidebar && (
          <p className="sidebar-banner dim">the other parent is talking privately…</p>
        )}

        <div className="chat">
          <MessageList
            messages={sceneMessages}
            streamingMessage={mp.streamingMessage}
            childName={state.childName}
            players={mp.players}
            mySlot={mySlot}
          />
          <MessageInput
            onSend={mp.sendMessage}
            disabled={inputDisabled}
            messagesRemaining={state.messagesRemaining}
            onTyping={mp.setTyping}
            partnerTyping={mp.partnerTyping}
            partnerName={partnerName}
          />
          {mp.sceneEnding && (
            <p className="dim scene-ending">the moment passes...</p>
          )}
          <div className="chat-controls">
            {inMySidebar && (
              <button className="btn btn-secondary" onClick={mp.endSidebar} disabled={mp.isStreaming}>
                rejoin family
              </button>
            )}
            {!sidebarActive && !mp.sceneEnding && (
              <button className="btn btn-secondary" onClick={mp.endChat} disabled={mp.isStreaming}>
                {state.phase === "adult_chat" ? "finish → report card" : "walk away"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === "processing") {
    return (
      <div className="app">
        <ProcessingScreen childName={state.childName} age={state.currentEvent?.age} gameId={mp.gameId} streamingText={mp.streamingDocText} />
      </div>
    );
  }

  // ---- Dark Play Plan 3: consult / therapy / cps_review ----
  // Reuse the same shared screens SoloGame (Task 5) renders. Solo advances
  // immediately on its single onContinue; here both parents must ready up
  // before the server's READY-in-<phase> branch applies the decay +
  // END_INTERVENTION and moves everyone on. The gate itself is a genuine
  // two-player barrier (see server/tests/ready-race.test.ts) and stays.
  //
  // What changed: the screen used to be REPLACED by a ReadyToggle the moment
  // you pressed its own "continue"/"conclude" — two screens, two buttons, and
  // the intervention text yanked away while you waited for your partner to
  // finish reading it. Now the screen stays mounted, its own button IS the
  // ready action (one interaction), and a thin strip below reports the count
  // and offers "not yet". `.gate-readied` dims the screen's own button once
  // you've readied so it doesn't read as unpressed — a second press would be
  // a harmless no-op anyway, since setReady(true) is idempotent server-side.
  const ladderWrapper = `app fade-in${meReady ? " gate-readied" : ""}`;

  if (state.phase === "consult") {
    return (
      <div className={ladderWrapper}>
        <ConsultScreen
          text={state.interventionText ?? ""}
          onContinue={() => mp.ready(true)}
        />
        <ReadyStrip ready={meReady} onCancel={() => mp.ready(false)} players={mp.players} />
      </div>
    );
  }

  if (state.phase === "cps_review") {
    return (
      <div className={ladderWrapper}>
        <CpsScreen
          text={state.interventionText ?? ""}
          onContinue={() => mp.ready(true)}
        />
        <ReadyStrip ready={meReady} onCancel={() => mp.ready(false)} players={mp.players} />
      </div>
    );
  }

  if (state.phase === "therapy") {
    const parentTurns = (state.therapyMessages ?? []).filter((m) => m.speaker === "parent").length;
    return (
      <div className={ladderWrapper}>
        <TherapyScreen
          messages={state.therapyMessages ?? []}
          // The server streams the therapist's reply via the same
          // DOC_CHUNK event other doc-generation flows use, but (unlike
          // endChat's identity doc) never follows it with DOC_DONE, so
          // mp.streamingDocText is never cleared back to "" here — wiring
          // it up would leave TherapyScreen's `canSend` permanently
          // false after the first reply. The transcript still updates
          // normally via the STATE rebroadcast once the reply finishes.
          streamingReply={undefined}
          canSend={parentTurns < THERAPY_TURN_CAP}
          onSend={mp.sendTherapyMessage}
          onConclude={() => mp.ready(true)}
        />
        <ReadyStrip ready={meReady} onCancel={() => mp.ready(false)} players={mp.players} />
      </div>
    );
  }

  // ---- Debrief ----
  // The screen sets up a private conversation between the two parents and,
  // until now, offered no way to have it. The kid is asleep: no kid presence,
  // no LLM turn, nothing generating between them — the one screen in the game
  // where two humans just talk. The conversation is optional; the "next
  // chapter" gate below it is unchanged and is still what advances the game.
  if (state.phase === "debrief") {
    // Both clauses matter. chatType keeps the family chat out; eventNumber
    // keeps chapter 1's debrief out of chapter 3's, since END_DEBRIEF never
    // resets `currentEventNumber`.
    const debriefMessages = state.messages.filter(
      (m) => m.chatType === "debrief" && m.eventNumber === state.currentEventNumber
    );
    return (
      <div className="app fade-in">
        <div className="debrief-enhanced">
          <div className="debrief-text-block">
            <p className="debrief-line-1">later that night</p>
            <p className="debrief-line-2">the kids are asleep. it's just you two.</p>
          </div>
          <div className="chat debrief-chat">
            {debriefMessages.length > 0 && (
              <MessageList
                messages={debriefMessages}
                // Nothing streams here — there is no kid to answer.
                streamingMessage=""
                childName={state.childName}
                players={mp.players}
                mySlot={mySlot}
              />
            )}
            <MessageInput
              onSend={mp.sendDebriefMessage}
              // No LLM waiting state: never disabled, never latched on
              // isStreaming (which the kid's reply owns and which nothing
              // would ever clear here).
              disabled={false}
              // No messagesRemaining: the debrief doesn't consume the
              // per-scene cap, so it must not show the cap's dots.
              onTyping={mp.setTyping}
              partnerTyping={mp.partnerTyping}
              partnerName={partnerName}
              placeholder="say something to your co-parent…"
              // Let the prose beat land before the keyboard covers it.
              autoFocus={false}
            />
          </div>
          <ReadyToggle
            ready={meReady}
            onToggle={mp.ready}
            label="next chapter"
            players={mp.players}
          />
        </div>
      </div>
    );
  }

  if (state.phase === "epilogue") {
    return (
      <div className="app fade-in">
        <Endgame epilogue={mp.epilogue} onContinue={mp.generateReportCard} />
      </div>
    );
  }

  if (state.phase === "report_card") {
    return (
      <div className="app fade-in">
        <ReportCard reportCard={mp.reportCard} childName={state.childName} />
      </div>
    );
  }

  return (
    <div className="app">
      <p>{state.phase}</p>
    </div>
  );
}

/**
 * The waiting half of a ready gate, without a button that arms it — for
 * screens that already have their own "continue"/"conclude" action (the
 * consult/therapy/CPS ladder). Keeps the gate visible and cancellable
 * without demanding a second press to enter it.
 */
function ReadyStrip({
  ready,
  onCancel,
  players,
}: {
  ready: boolean;
  onCancel: () => void;
  players: { ready: boolean }[];
}) {
  const readyCount = players.filter((p) => p.ready).length;
  return (
    <div className="ready-toggle ready-strip">
      {ready && (
        <div className="ready-waiting" role="status" aria-live="polite">
          <div className="guardian-spinner" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
          <p className="ready-waiting-label">you're ready</p>
          <button className="btn dim ready-cancel" onClick={onCancel}>
            not yet
          </button>
        </div>
      )}
      <p className="dim ready-count">{readyCount} of {players.length} ready</p>
    </div>
  );
}

function ReadyToggle({
  ready,
  onToggle,
  label,
  players,
}: {
  ready: boolean;
  onToggle: (v: boolean) => void;
  label: string;
  players: { ready: boolean }[];
}) {
  const readyCount = players.filter((p) => p.ready).length;
  return (
    <div className="ready-toggle">
      {ready ? (
        <div className="ready-waiting" role="status" aria-live="polite">
          <div className="guardian-spinner" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
          <p className="ready-waiting-label">you're ready</p>
          <button className="btn dim ready-cancel" onClick={() => onToggle(false)}>
            not yet
          </button>
        </div>
      ) : (
        <button className="btn" onClick={() => onToggle(true)}>
          {label}
        </button>
      )}
      <p className="dim ready-count">{readyCount} of {players.length} ready</p>
    </div>
  );
}
