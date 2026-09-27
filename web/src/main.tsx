import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  meetingSnapshotSchema,
  serverEventSchema,
  type MeetingSnapshot,
  type HealthResponse,
  type CalendarAction,
} from "../../src/shared/contracts";
import "./styles.css";

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<RecognitionResult>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
const speech =
  (window as SpeechWindow).SpeechRecognition ||
  (window as SpeechWindow).webkitSpeechRecognition;
const storage = {
  get: () => {
    try {
      return sessionStorage.getItem("glance.token") || "";
    } catch {
      return "";
    }
  },
  set: (s: string) => {
    try {
      s
        ? sessionStorage.setItem("glance.token", s)
        : sessionStorage.removeItem("glance.token");
    } catch {}
  },
};
const initialRoomId = () => {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
};
const safeUrl = (s?: string) => (s && /^https?:\/\//i.test(s) ? s : undefined);
function downloadText(title: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[^a-z0-9]+/gi, "-").slice(0, 70) || "meeting-notes"}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Icon({
  name,
}: {
  name: "mic" | "pause" | "arrow" | "link" | "close";
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "mic" ? (
        <>
          <rect x="9" y="2" width="6" height="13" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </>
      ) : name === "pause" ? (
        <>
          <path d="M8 5v14M16 5v14" />
        </>
      ) : name === "arrow" ? (
        <path d="M5 12h14m-6-6 6 6-6 6" />
      ) : name === "link" ? (
        <>
          <path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />
        </>
      ) : (
        <path d="m6 6 12 12M6 18 18 6" />
      )}
    </svg>
  );
}
function App() {
  const [token, setToken] = useState(storage.get),
    [draftToken, setDraftToken] = useState(storage.get),
    [meeting, setMeeting] = useState<MeetingSnapshot>(),
    [health, setHealth] = useState<HealthResponse>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connection, setConnection] = useState("Not connected"),
    [reconnect, setReconnect] = useState(0),
    [tab, setTab] = useState<"conversation" | "notes" | "work">("conversation"),
    [message, setMessage] = useState(""),
    [manual, setManual] = useState(""),
    [listening, setListening] = useState(false),
    [micStarting, setMicStarting] = useState(false),
    [interim, setInterim] = useState(""),
    [notice, setNotice] = useState(""),
    [reviewed, setReviewed] = useState(""),
    [settings, setSettings] = useState(false);
  const recognition = useRef<Recognition | null>(null),
    listenWanted = useRef(false),
    meetingRef = useRef(meeting),
    tokenRef = useRef(token),
    speechQueue = useRef<Promise<void>>(Promise.resolve()),
    connectionInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (settings) connectionInput.current?.focus();
  }, [settings]);
  meetingRef.current = meeting;
  tokenRef.current = token;
  const request = useCallback(
    async (path: string, body?: unknown, auth = tokenRef.current) => {
      const response = await fetch(`/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(120000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : data.error?.message ||
                data.message ||
                `Request failed (${response.status}).`,
        );
      return data;
    },
    [],
  );
  const stop = useCallback(() => {
    listenWanted.current = false;
    try {
      recognition.current?.stop();
    } catch {}
    setMicStarting(false);
    setListening(false);
    setInterim("");
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not complete this request.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function load(id: string, auth = tokenRef.current) {
    const data = await request(
      `/meetings/${encodeURIComponent(id)}`,
      undefined,
      auth,
    );
    const next = meetingSnapshotSchema.parse(data);
    meetingRef.current = next;
    setMeeting(next);
    location.hash = next.id;
  }
  useEffect(() => {
    request("/health")
      .then(setHealth)
      .catch(() => setHealth(undefined));
  }, [request, reconnect, token]);
  useEffect(() => {
    if (!meeting?.id || !token) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>,
      socket: WebSocket;
    let tries = 0;
    function open() {
      if (cancelled) return;
      setConnection("Connecting");
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/meetings/${encodeURIComponent(meeting!.id)}/events`,
      );
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "auth", token }));
      };
      socket.onmessage = (event) => {
        try {
          const parsed = serverEventSchema.safeParse(JSON.parse(event.data));
          if (!parsed.success) {
            setError(
              "The runtime sent an unreadable update. Reconnect to refresh the conversation.",
            );
            return;
          }
          const e = parsed.data;
          if (e.meetingId !== meeting!.id) return;
          if (e.type === "error") {
            setError(e.payload.message);
            return;
          }
          if (e.type === "transcript") setReviewed("");
          setConnection("Connected");
          tries = 0;
          setMeeting((current) => {
            if (!current || current.id !== e.meetingId) return current;
            switch (e.type) {
              case "snapshot":
                return e.payload;
              case "transcript": {
                const previous = current.transcript.find(
                  (t) => t.id === e.payload.id,
                );
                if (previous && previous.revision > e.payload.revision)
                  return current;
                return {
                  ...current,
                  transcript: [
                    ...current.transcript.filter((t) => t.id !== e.payload.id),
                    e.payload,
                  ],
                };
              }
              case "cue":
                return { ...current, cue: e.payload };
              case "summary":
                return { ...current, summary: e.payload };
              case "task":
                return {
                  ...current,
                  tasks: [
                    ...current.tasks.filter((t) => t.id !== e.payload.task.id),
                    e.payload.task,
                  ],
                };
              case "action":
                return { ...current, calendarAction: e.payload.calendarAction };
              case "status":
                return { ...current, ...e.payload };
              default:
                return current;
            }
          });
        } catch {
          setError(
            "An update could not be read. Reconnect to refresh the conversation.",
          );
        }
      };
      socket.onclose = (e) => {
        if (cancelled) return;
        setConnection("Connection lost");
        stop();
        if (e.code === 1008) {
          setError(
            "Connection was rejected. Check your access token and reconnect.",
          );
          return;
        }
        timer = setTimeout(open, Math.min(1000 * 2 ** tries++, 15000));
      };
      socket.onerror = () => setConnection("Connection lost");
    }
    open();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [meeting?.id, token, reconnect, stop]);
  useEffect(() => {
    if (meeting?.status === "ended" || meeting?.status === "paused") stop();
  }, [meeting?.status, stop]);
  useEffect(
    () => () => {
      listenWanted.current = false;
      recognition.current?.abort();
    },
    [],
  );
  async function append(
    text: string,
    speaker = "Browser microphone",
    meetingId = meetingRef.current?.id,
  ) {
    if (!meetingId) return;
    const data = await request(
      `/meetings/${encodeURIComponent(meetingId)}/transcript`,
      {
        segmentId: crypto.randomUUID(),
        text,
        isFinal: true,
        revision: 0,
        speaker,
      },
    );
    const snapshot = meetingSnapshotSchema.parse(data);
    if (meetingRef.current?.id === meetingId) setMeeting(snapshot);
  }
  function start() {
    if (!speech) return;
    setError("");
    setMicStarting(true);
    const recordingMeetingId = meetingRef.current?.id;
    const rec = new speech();
    recognition.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    listenWanted.current = true;
    rec.onstart = () => {
      setMicStarting(false);
      setListening(true);
    };
    rec.onresult = (event) => {
      let partial = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          speechQueue.current = speechQueue.current
            .then(() =>
              append(r[0].transcript, "Browser microphone", recordingMeetingId),
            )
            .catch((e) => {
              setError(`Transcript was not saved: ${e.message}`);
              stop();
            });
        } else partial += r[0].transcript;
      }
      setInterim(partial);
    };
    rec.onerror = (e) => {
      if (
        e.error === "no-speech" ||
        (e.error === "aborted" && !listenWanted.current)
      )
        return;
      setError(
        `Microphone transcription stopped (${e.error}). Check browser microphone permission, then try again.`,
      );
      stop();
    };
    rec.onend = () => {
      if (listenWanted.current) {
        try {
          rec.start();
        } catch {
          stop();
        }
      }
    };
    try {
      rec.start();
    } catch {
      stop();
      setError("Microphone could not start. Check permissions and try again.");
    }
  }
  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const data = await request(
        `/meetings/${encodeURIComponent(meeting!.id)}/messages`,
        { text: message.trim(), participantId: "operator" },
      );
      setMeeting(meetingSnapshotSchema.parse(data));
      setMessage("");
      setNotice("Added to the conversation.");
    });
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}${location.pathname}#${meeting!.id}`,
      );
      setNotice("Conversation link copied.");
    } catch {
      setNotice("Copy the current browser address to share this conversation.");
    }
  }
  const action = meeting?.calendarAction,
    reviewKey = action
      ? `${action.id}:${action.proposalVersion}:${meeting?.revision}`
      : "";
  async function beginListening() {
    if (!token.trim()) {
      setSettings(true);
      return;
    }
    await run(async () => {
      let current = meetingRef.current;
      if (!current || current.status === "ended") {
        const data = await request("/meetings", { title: "Meeting" });
        current = meetingSnapshotSchema.parse(data);
      } else if (current.status === "paused") {
        current = meetingSnapshotSchema.parse(
          await request(`/meetings/${encodeURIComponent(current.id)}/control`, {
            action: "resume",
          }),
        );
      }
      meetingRef.current = current;
      setMeeting(current);
      try {
        sessionStorage.setItem("glance.meeting", current.id);
      } catch {}
      location.hash = current.id;
      if (speech) start();
      else
        setError(
          "Listening is unavailable in this browser. Use the native kompX app, or add text in Settings → Advanced.",
        );
    });
  }
  async function finishCapture() {
    const rec = recognition.current;
    if (rec && (listening || micStarting)) {
      listenWanted.current = false;
      await new Promise<void>((resolve) => {
        const previousEnd = rec.onend;
        const timer = setTimeout(() => {
          try {
            rec.abort();
          } catch {}
          resolve();
        }, 2500);
        rec.onend = () => {
          clearTimeout(timer);
          previousEnd?.();
          resolve();
        };
        stop();
      });
    } else stop();
    await speechQueue.current;
  }
  async function pauseListening() {
    await run(async () => {
      await finishCapture();
      if (meeting)
        setMeeting(
          meetingSnapshotSchema.parse(
            await request(
              `/meetings/${encodeURIComponent(meeting.id)}/control`,
              { action: "pause" },
            ),
          ),
        );
    });
  }
  useEffect(() => {
    if (!token) return;
    const restore = () => {
      let id = initialRoomId();
      if (!id || id === "main") {
        try {
          id = sessionStorage.getItem("glance.meeting") || "";
        } catch {}
      }
      if (id && id !== meetingRef.current?.id) {
        stop();
        void run(() => load(id));
      }
    };
    restore();
    window.addEventListener("hashchange", restore);
    return () => window.removeEventListener("hashchange", restore);
  }, [token, reconnect]);
  useEffect(() => {
    if (!meeting) return;
    try {
      sessionStorage.setItem("glance.meeting", meeting.id);
    } catch {}
  }, [meeting?.id]);
  const listeningLabel = micStarting
    ? "Starting microphone…"
    : listening
      ? "Listening"
      : meeting?.status === "ended"
        ? "Conversation finished"
        : "Microphone off";
  return (
    <div className="glance-app">
      <a className="skip" href="#main">
        Skip to kompX
      </a>
      <header className="app-header">
        <h1 className="app-wordmark">kompX</h1>
        <div className="app-tools">
          {meeting && (
            <button
              className="icon-button"
              onClick={share}
              aria-label="Share conversation"
            >
              <Icon name="link" />
            </button>
          )}
          <button
            className="icon-button"
            onClick={() => setSettings(!settings)}
            aria-expanded={settings}
            aria-label="Settings"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="21"
              height="21"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              <path d="M4 7h16M4 17h16" />
              <circle cx="9" cy="7" r="3" fill="currentColor" />
              <circle cx="15" cy="17" r="3" fill="currentColor" />
            </svg>
          </button>
        </div>
      </header>
      {error && (
        <div className="app-notice error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {notice && (
        <div className="app-notice" role="status">
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {settings && (
        <section className="settings-panel" aria-labelledby="settings-title">
          <div className="section-title">
            <h2 id="settings-title">Settings</h2>
            <button
              className="icon-button"
              aria-label="Close settings"
              onClick={() => setSettings(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const auth = draftToken.trim();
              storage.set(auth);
              tokenRef.current = auth;
              setToken(auth);
              setSettings(false);
              setError("");
            }}
          >
            <label>
              Connection token
              <input
                ref={connectionInput}
                type="password"
                autoComplete="off"
                value={draftToken}
                onChange={(event) => setDraftToken(event.target.value)}
                placeholder="Paste your local connection token"
              />
            </label>
            <p className="field-note">
              One-time pairing for this browser tab. The token stays in session
              storage.
            </p>
            <button className="primary" disabled={!draftToken.trim()}>
              Save connection
            </button>
          </form>
          <details className="advanced">
            <summary>Advanced</summary>
            <p className="field-note">
              This browser is a companion. Meta device connection and audio run
              in the native app.
            </p>
            <p className="field-note">
              Browser listening uses Web Speech and may send audio to your
              browser provider. Only final text is saved to the conversation.
            </p>
            <p className="field-note">
              {meeting ? `Connection: ${connection}` : "No active conversation"}
            </p>
            <button
              className="small"
              onClick={() => setReconnect((value) => value + 1)}
            >
              Refresh connection
            </button>
            <ProviderStatus health={health} />
            {meeting && (
              <>
                <p className="field-note">
                  {meeting.providerMode === "fixture"
                    ? "Fixture runtime — test output only"
                    : `Runtime mode: ${meeting.providerMode || "unknown"}`}
                </p>
                {meeting.finalization && (
                  <p className="field-note">
                    Handoff: {meeting.finalization.state}
                    {meeting.finalization.receipt && (
                      <>
                        {" "}
                        · Receipt {meeting.finalization.receipt.id}
                        {safeUrl(meeting.finalization.receipt.url) && (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              href={safeUrl(meeting.finalization.receipt.url)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open saved handoff
                            </a>
                          </>
                        )}
                      </>
                    )}
                  </p>
                )}
                {meeting.warnings?.map((warning) => (
                  <p className="field-note" key={warning.code}>
                    {warning.message}
                  </p>
                ))}
                <form
                  className="manual-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await append(manual.trim(), "Manual transcript");
                      setManual("");
                    });
                  }}
                >
                  <label>
                    Add transcript text
                    <textarea
                      value={manual}
                      onChange={(event) => setManual(event.target.value)}
                      placeholder="A spoken passage for testing"
                    />
                  </label>
                  <button
                    disabled={
                      busy || !manual.trim() || meeting.status !== "listening"
                    }
                  >
                    Add passage
                  </button>
                </form>
                <details className="debug-transcript">
                  <summary>
                    Saved transcript · {meeting.transcript.length}
                  </summary>
                  {meeting.transcript.map((segment) => (
                    <article className="passage" key={segment.id}>
                      <div className="passage-meta">
                        {segment.speaker || "Speaker"}
                        {!segment.isFinal && " · Partial"}
                      </div>
                      <p>{segment.text}</p>
                    </article>
                  ))}
                </details>
                {!!meeting.operatorMessages?.length && (
                  <details className="debug-transcript">
                    <summary>Questions & corrections</summary>
                    {meeting.operatorMessages.map((note) => (
                      <p key={note.id}>{note.text}</p>
                    ))}
                  </details>
                )}
              </>
            )}
          </details>
        </section>
      )}
      <main id="main" className="main-surface">
        <div className="listening-bar">
          <span className={`dot ${listening ? "live" : ""}`} />
          <span>{listeningLabel}</span>
          {meeting && connection !== "Connected" && (
            <button
              className="reconnect"
              onClick={() => setReconnect((value) => value + 1)}
            >
              Reconnect
            </button>
          )}
        </div>
        <nav className="simple-tabs" aria-label="kompX views">
          {(
            [
              ["conversation", "Now"],
              ["work", "Tasks"],
              ["notes", "Summary"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              aria-current={tab === value ? "page" : undefined}
            >
              {label}
              {value === "work" && !!meeting?.tasks.length && (
                <span>{meeting.tasks.length}</span>
              )}
            </button>
          ))}
        </nav>
        {tab === "conversation" ? (
          <section className="now-view" aria-label="Current helpful thought">
            <div className={`thought ${meeting?.cue ? "ready" : ""}`}>
              <p aria-live="polite">
                {meeting?.cue?.text || (listening ? "Listening…" : "")}
              </p>
              {!meeting?.cue && (
                <span>
                  {listening ? "Useful thoughts will appear here." : ""}
                </span>
              )}
            </div>
            {meeting?.cue && (
              <details className="thought-details">
                <summary>
                  More detail
                  {meeting.cue.evidence.length
                    ? ` · ${meeting.cue.evidence.length} sources`
                    : ""}
                </summary>
                {meeting.cue.detail && <p>{meeting.cue.detail}</p>}
                {meeting.cue.evidence.map((evidence) => (
                  <div className="source" key={evidence.id}>
                    <strong>{evidence.label}</strong>
                    <p>{evidence.text}</p>
                    {safeUrl(evidence.url) && (
                      <a
                        href={safeUrl(evidence.url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open source ↗
                      </a>
                    )}
                  </div>
                ))}
              </details>
            )}
            {interim && (
              <p className="interim" aria-live="off">
                {interim}
              </p>
            )}
            <button
              className="listen-button"
              onClick={() =>
                void (listening ? pauseListening() : beginListening())
              }
              disabled={busy || micStarting}
            >
              <Icon name={listening ? "pause" : "mic"} />
              {micStarting ? "Starting…" : listening ? "Pause" : "Start"}
            </button>
            {meeting && meeting.status !== "ended" && (
              <form className="ask-form" onSubmit={sendMessage}>
                <label className="visually-hidden" htmlFor="message">
                  Ask or correct something
                </label>
                <input
                  id="message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Ask or correct something"
                  maxLength={4000}
                />
                <button
                  className="icon-button"
                  disabled={busy || !message.trim()}
                  aria-label="Send message"
                >
                  <Icon name="arrow" />
                </button>
              </form>
            )}
          </section>
        ) : tab === "work" ? (
          <section className="simple-work" aria-label="Tasks">
            {meeting?.tasks.length ? (
              meeting.tasks.map((task) => (
                <article className="simple-task" key={task.id}>
                  <div className="section-title">
                    <h2>{task.title}</h2>
                    <span className={`badge ${task.status}`}>
                      {task.status}
                    </span>
                  </div>
                  {task.content && (
                    <details>
                      <summary>View document</summary>
                      <pre className="document-content">{task.content}</pre>
                      <button
                        className="small"
                        onClick={() => downloadText(task.title, task.content!)}
                      >
                        Download
                      </button>
                    </details>
                  )}
                  {task.error && <p className="error-text">{task.error}</p>}
                  {safeUrl(task.url) && (
                    <a
                      href={safeUrl(task.url)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open result ↗
                    </a>
                  )}
                </article>
              ))
            ) : (
              <div className="simple-empty">
                <h2>No tasks yet.</h2>
                <p>Ask kompX to handle a next step during the conversation.</p>
              </div>
            )}
            {action && (
              <CalendarPreview
                action={action}
                reviewed={reviewed === reviewKey}
                onReview={(value) => setReviewed(value ? reviewKey : "")}
                busy={busy}
                onConfirm={() =>
                  void run(async () => {
                    setMeeting(
                      meetingSnapshotSchema.parse(
                        await request(
                          `/meetings/${encodeURIComponent(meeting!.id)}/actions/${encodeURIComponent(action.id)}/confirm`,
                          { proposalVersion: action.proposalVersion },
                        ),
                      ),
                    );
                    setReviewed("");
                  })
                }
              />
            )}
          </section>
        ) : (
          <section className="simple-summary" aria-label="Summary">
            {meeting?.summary ? (
              <>
                <p className="summary-lead">{meeting.summary.text}</p>
                {(
                  [
                    ["Decisions", meeting.summary.decisions],
                    ["Open questions", meeting.summary.openQuestions],
                    ["Owners", meeting.summary.owners],
                    ["Next steps", meeting.summary.nextSteps],
                  ] as [string, string[]][]
                )
                  .filter(([, items]) => items.length)
                  .map(([label, items]) => (
                    <section key={label}>
                      <h2>{label}</h2>
                      <ul>
                        {items.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  ))}
                <button
                  className="small"
                  onClick={() =>
                    downloadText(
                      "Meeting summary",
                      meeting.summary!.text +
                        "\n\n" +
                        (
                          [
                            ["Decisions", meeting.summary!.decisions],
                            ["Open questions", meeting.summary!.openQuestions],
                            ["Owners", meeting.summary!.owners],
                            ["Next steps", meeting.summary!.nextSteps],
                          ] as [string, string[]][]
                        )
                          .map(
                            ([label, items]) =>
                              `## ${label}\n\n${items.map((item) => `- ${item}`).join("\n") || "None recorded."}`,
                          )
                          .join("\n\n"),
                    )
                  }
                >
                  Download summary
                </button>
              </>
            ) : (
              <div className="simple-empty">
                <h2>
                  {meeting?.finalization?.state === "running"
                    ? "Preparing your summary…"
                    : "The useful parts, kept."}
                </h2>
                <p>
                  {meeting?.status === "ended"
                    ? "A summary will appear here when it is ready."
                    : "Decisions and next steps stay here after the conversation."}
                </p>
              </div>
            )}
            {meeting?.finalization?.state === "failed" && (
              <p className="error-text">
                {meeting.finalization.error ||
                  "The summary could not be saved."}
              </p>
            )}
            {meeting?.finalization?.state === "completed" && (
              <p className="field-note">Saved to shared memory.</p>
            )}
            {meeting && meeting.status !== "ended" && (
              <button
                className="finish-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await finishCapture();
                    setMeeting(
                      meetingSnapshotSchema.parse(
                        await request(
                          `/meetings/${encodeURIComponent(meeting.id)}/end`,
                          {},
                        ),
                      ),
                    );
                  })
                }
              >
                Finish & summarize
              </button>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function ProviderStatus({ health }: { health?: HealthResponse }) {
  return (
    <div className="providers">
      <span className="provider-heading">Runtime connections</span>
      {health ? (
        Object.entries(health.providers).map(([name, status]) => (
          <span className="provider" key={name}>
            <span
              className={`dot ${status === "configured" ? "configured" : ""}`}
            />
            {name === "qm" ? "QM" : name === "gbrain" ? "GBrain" : "Memorable"}{" "}
            <span>{status}</span>
          </span>
        ))
      ) : (
        <span className="muted">Runtime health unavailable</span>
      )}
      <p className="field-note">
        Configured does not imply a verified provider connection.
      </p>
    </div>
  );
}
function CalendarPreview({
  action,
  reviewed,
  onReview,
  busy,
  onConfirm,
}: {
  action: CalendarAction;
  reviewed: boolean;
  onReview: (v: boolean) => void;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <section className="calendar">
      <div className="task-heading">
        <h3>Calendar invitation</h3>
        <span className="badge">{action.status}</span>
      </div>
      <h4>{action.title}</h4>
      <dl>
        <dt>Starts</dt>
        <dd>{action.start}</dd>
        <dt>Ends</dt>
        <dd>{action.end}</dd>
        <dt>Time zone</dt>
        <dd>{action.timeZone}</dd>
        <dt>Attendees</dt>
        <dd>
          {action.attendees.length
            ? action.attendees.map((a) => (
                <div key={a.email}>
                  {a.name && `${a.name} · `}
                  {a.email}
                </div>
              ))
            : "No attendees specified"}
        </dd>
      </dl>
      <p className="invite-description">{action.description}</p>
      {action.providerError && (
        <p className="error-text" role="status">
          {action.providerError}
        </p>
      )}
      {action.status === "uncertain" && (
        <p className="error-text">
          Delivery could not be verified. Check the calendar provider before
          trying another invitation.
        </p>
      )}
      {action.status === "proposed" && (
        <>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => onReview(e.target.checked)}
            />
            <span>
              I reviewed the exact timing, attendees, and invitation above.
            </span>
          </label>
          <button
            className="primary"
            disabled={!reviewed || busy}
            onClick={onConfirm}
          >
            {busy ? "Confirming…" : "Confirm invitation"}
          </button>
          <p className="field-note">
            Proposal version {action.proposalVersion}. Changes require a new
            review.
          </p>
        </>
      )}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
