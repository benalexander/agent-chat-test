import { useCallback } from 'react';
import { api, ApiError, errorMessage } from './api';
import { resolveTz, shortId } from './format';
import { usePoll } from './hooks';
import { Sidebar } from './Sidebar';
import { Transcript } from './Transcript';

export function UserPage({ userId, onDeleted }: { userId: string; onDeleted: (note: string) => void }) {
  const fetcher = useCallback(() => api.getUser(userId), [userId]);
  const { data, error, loading, refresh } = usePoll(fetcher, 4000, userId);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="panel empty">
        <p>
          Unknown user <span className="mono">{userId}</span>.
        </p>
        <p>
          <a href="#/">Back to users</a>
        </p>
      </div>
    );
  }

  if (!data) {
    return loading ? (
      <p className="muted">Loading…</p>
    ) : (
      <p className="error">Failed to load user: {errorMessage(error)}</p>
    );
  }

  const tz = resolveTz(data.state.timezone ?? data.user.timezone);
  const tzKnown = !!(data.state.timezone ?? data.user.timezone);

  return (
    <section>
      <div className="page-head">
        <a href="#/">← Users</a>
        <h1 className="mono" title={userId}>
          {shortId(userId)}
        </h1>
        <span className="mono muted small">{userId}</span>
        <span className="spacer" />
        <span className="tz-label">
          Times in {tz}
          {!tzKnown && ' (browser; device timezone unknown)'}
        </span>
      </div>
      {error != null && <p className="error">Refresh failed: {errorMessage(error)} (showing last data)</p>}
      <div className="user-layout">
        <Transcript detail={data} tz={tz} />
        <Sidebar detail={data} tz={tz} refresh={refresh} onDeleted={onDeleted} />
      </div>
    </section>
  );
}
