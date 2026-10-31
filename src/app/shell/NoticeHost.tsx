import { dismissNotice, useUserNotices } from "../../shared/notice";

/** Bottom-center non-blocking notices; replaces modal confirmations for direct writes. */
export function NoticeHost() {
  const notices = useUserNotices();
  if (!notices.length) return null;
  return (
    <div className="app-notice-host" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`app-notice ${notice.kind === "error" ? "error" : ""}`}
        >
          <span>{notice.message}</span>
          <button
            aria-label="关闭提示 / Dismiss"
            onClick={() => dismissNotice(notice.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
