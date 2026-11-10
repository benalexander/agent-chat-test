import { api, errorMessage } from './api';
import { fmtInt, fmtRaised, resolveTz, shortId } from './format';
import { Time, usePoll, userHref } from './hooks';

export function UsersList() {
  const { data, error, loading } = usePoll(api.listUsers, 5000, 'users');
  const users = data?.users ?? [];

  return (
    <section>
      <div className="page-head">
        <h1>Users</h1>
        <span className="muted">Times shown in each device's own timezone. Hover a time for relative.</span>
      </div>
      {error != null && <p className="error">Failed to load users: {errorMessage(error)}</p>}
      {loading && !data ? (
        <p className="muted">Loading…</p>
      ) : users.length === 0 ? (
        <div className="panel empty">
          <p>No devices registered yet.</p>
          <p className="muted">
            A device registers on its next request to the worker (opening the app, syncing or sending a message).
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table users-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Timezone</th>
                <th>First seen</th>
                <th>Last seen</th>
                <th className="num">Messages</th>
                <th>Last message</th>
                <th>Raised / target</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const tz = resolveTz(u.timezone);
                const open = () => {
                  location.hash = userHref(u.userId);
                };
                return (
                  <tr key={u.userId} className="clickable" onClick={open}>
                    <td className="mono" title={u.userId}>
                      <a href={userHref(u.userId)} onClick={(e) => e.stopPropagation()}>
                        {shortId(u.userId)}
                      </a>
                    </td>
                    <td>{u.timezone ?? <span className="muted">unknown</span>}</td>
                    <td>
                      <Time ms={u.firstSeen} tz={tz} />
                    </td>
                    <td>
                      <Time ms={u.lastSeen} tz={tz} />
                    </td>
                    <td className="num">{u.summary ? fmtInt(u.summary.messageCount) : '—'}</td>
                    <td>
                      <Time ms={u.summary?.lastMessageAt} tz={tz} />
                    </td>
                    <td>{u.summary ? fmtRaised(u.summary.raised, u.summary.target) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
