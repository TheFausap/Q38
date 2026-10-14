import { formatTokens } from "../lib/context";
import type { ArchiveRef } from "../lib/types";

/**
 * The memory card: what used to be a fold card, now a list of what is on disk.
 * Every line is the register the model sees, so the window and the card never
 * disagree about what the model knows.
 */
export function ArchiveCard({
  chunks,
  held,
  root,
  busy,
  onPullBack,
  onRelease,
  onForget,
  onUnarchive,
  disabled,
}: {
  chunks: ArchiveRef[];
  held: string[];
  root?: string;
  busy: string | null;
  onPullBack: (id: string) => void;
  onRelease: (id: string) => void;
  onForget: (id: string) => void;
  onUnarchive: () => void;
  disabled: boolean;
}) {
  if (!chunks.length) return null;
  const tokens = chunks.reduce((n, c) => n + c.tokens, 0);
  const heldSet = new Set(held);
  return (
    <div className="mem-card">
      <div className="mem-head">
        <span className="mem-title">
          memory · {chunks.length} chunk{chunks.length === 1 ? "" : "s"} on disk ·{" "}
          {formatTokens(tokens)} prompt tokens out of the window
        </span>
        <button
          type="button"
          className="icon-btn"
          disabled={disabled || busy !== null}
          onClick={onUnarchive}
          title="Bring every chunk back into the window and clear the archive"
        >
          unarchive
        </button>
      </div>
      <ul className="mem-list">
        {chunks.map((c) => {
          const isHeld = heldSet.has(c.id);
          return (
            <li key={c.id} className={`mem-row ${isHeld ? "held" : ""}`}>
              <span className="mem-line" title={c.register}>
                {c.register}
              </span>
              <span className="mem-when">
                {new Date(c.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                {c.recalls > 0 ? ` · recalled ×${c.recalls}` : ""}
              </span>
              <span className="mem-actions">
                {isHeld ? (
                  <button
                    type="button"
                    className="linkish"
                    disabled={disabled || busy !== null}
                    onClick={() => onRelease(c.id)}
                    title="Send it back out of the window"
                  >
                    let go
                  </button>
                ) : (
                  <button
                    type="button"
                    className="linkish"
                    disabled={disabled || busy !== null}
                    onClick={() => onPullBack(c.id)}
                    title="Read this chunk back from disk into the window"
                  >
                    {busy === c.id ? "reading…" : "pull back"}
                  </button>
                )}
                <button
                  type="button"
                  className="linkish danger-text"
                  disabled={disabled || busy !== null}
                  onClick={() => onForget(c.id)}
                  title="Delete this chunk from disk. The messages stay in the transcript."
                >
                  forget
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mem-foot muted tiny">
        {held.length
          ? `${held.length} chunk${held.length === 1 ? "" : "s"} pinned back in the window by hand.`
          : "Nothing was summarised. A chunk comes back the moment a turn needs it, or when you pull it."}
        {root ? <> · store: <code>{root}</code></> : null}
      </p>
    </div>
  );
}
