import { useState, type FormEvent, type ReactNode } from 'react';
import type {
  AdminActionResponse,
  AdminUserDetail,
  CampaignState,
  ProactiveTrigger,
  TokenTotals,
  UpdateCampaignRequest,
} from '@agent-chat/shared';
import { api, errorMessage } from './api';
import { fmtInt, fmtMoney, fmtRaised, fromDateInput, toDateInput } from './format';
import { Time } from './hooks';

interface Props {
  detail: AdminUserDetail;
  tz: string;
  refresh: () => Promise<void>;
  onDeleted: (note: string) => void;
}

const DEVICE_RESET_NOTE =
  'On the device, also run "reset agent + local DB" from its Debug tab; otherwise its local DB is ahead of the server.';

export function Sidebar({ detail, tz, refresh, onDeleted }: Props) {
  const userId = detail.user.userId;
  return (
    <aside className="sidebar">
      <CampaignPanel userId={userId} campaign={detail.state.campaign} tz={tz} refresh={refresh} />
      <ActionsPanel userId={userId} refresh={refresh} />
      <InfoPanel detail={detail} />
      <SchedulesPanel detail={detail} tz={tz} />
      <TokensPanel detail={detail} tz={tz} />
      <DangerPanel userId={userId} refresh={refresh} onDeleted={onDeleted} />
    </aside>
  );
}

function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ''}`}>
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

// ---- Action plumbing -------------------------------------------------------------

type Result = { ok: boolean; text: string } | null;

function describe(r: AdminActionResponse): Result {
  const parts = [r.ok ? 'OK' : 'Not OK'];
  if (r.outcome) parts.push(`outcome: ${r.outcome}`);
  if (r.message) parts.push(r.message);
  return { ok: r.ok, text: parts.join(' · ') };
}

/** Runs an action, records its result, then refreshes the page data immediately. */
function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const run = async (fn: () => Promise<Result>) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await fn());
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
    await refresh();
  };
  return { busy, result, run };
}

function ResultLine({ result }: { result: Result }) {
  if (!result) return null;
  return <p className={result.ok ? 'result ok' : 'result fail'}>{result.text}</p>;
}

// ---- Campaign ----------------------------------------------------------------------

function CampaignPanel({
  userId,
  campaign: c,
  tz,
  refresh,
}: {
  userId: string;
  campaign: CampaignState;
  tz: string;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const daysLeft = Math.ceil((c.endsAt - Date.now()) / 86_400_000);
  return (
    <Panel title="Campaign">
      <dl className="dl">
        <Row label="Name">{c.name}</Row>
        <Row label="Charity">{c.charity}</Row>
        <Row label="Raised">{fmtRaised(c.raised, c.target)}</Row>
        <Row label="Donors">{fmtInt(c.donorCount)}</Row>
        <Row label="Ends">
          <Time ms={c.endsAt} tz={tz} dateOnly />{' '}
          <span className="muted">
            ({daysLeft >= 0 ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'ended'})
          </span>
        </Row>
        <Row label="Milestones">{c.milestonesHit.length ? c.milestonesHit.map((m) => `${m}%`).join(', ') : 'none'}</Row>
        <Row label="Last activity">
          <Time ms={c.lastActivityAt} tz={tz} />
        </Row>
      </dl>
      {editing ? (
        <CampaignEditForm
          userId={userId}
          campaign={c}
          tz={tz}
          refresh={refresh}
          onClose={() => setEditing(false)}
        />
      ) : (
        <button className="btn" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
    </Panel>
  );
}

/** Initialised once from the campaign when opened; polling doesn't overwrite it. */
function CampaignEditForm({
  userId,
  campaign: c,
  tz,
  refresh,
  onClose,
}: {
  userId: string;
  campaign: CampaignState;
  tz: string;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [initial] = useState(() => ({
    raised: String(c.raised),
    target: String(c.target),
    donorCount: String(c.donorCount),
    endsAt: toDateInput(c.endsAt, tz),
    endsAtMs: c.endsAt,
  }));
  const [raised, setRaised] = useState(initial.raised);
  const [target, setTarget] = useState(initial.target);
  const [donorCount, setDonorCount] = useState(initial.donorCount);
  const [endsAt, setEndsAt] = useState(initial.endsAt);
  const { busy, result, run } = useAction(refresh);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Only send fields that changed.
    const body: UpdateCampaignRequest = {};
    if (raised !== initial.raised) body.raised = Number(raised);
    if (target !== initial.target) body.target = Number(target);
    if (donorCount !== initial.donorCount) body.donorCount = Number(donorCount);
    if (endsAt && endsAt !== initial.endsAt) body.endsAt = fromDateInput(endsAt, tz, initial.endsAtMs);
    void run(async () => {
      if (Object.keys(body).length === 0) return { ok: true, text: 'Nothing changed.' };
      const res = await api.updateCampaign(userId, body);
      return {
        ok: res.ok,
        text: res.ok
          ? `Saved: ${fmtRaised(res.campaign.raised, res.campaign.target)}, milestones ${res.campaign.milestonesHit.join('/') || 'none'}`
          : 'Not saved',
      };
    });
  };

  return (
    <form className="form" onSubmit={submit}>
      <p className="note">
        Silent edit: no message is sent to the user. Milestones are recomputed so thresholds at or below the new
        percentage are marked hit and won't fire later.
      </p>
      <div className="grid2">
        <label className="field">
          <span>Raised (A$)</span>
          <input type="number" min={0} step={1} required value={raised} onChange={(e) => setRaised(e.target.value)} />
        </label>
        <label className="field">
          <span>Target (A$)</span>
          <input type="number" min={1} step={1} required value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label className="field">
          <span>Donors</span>
          <input
            type="number"
            min={0}
            step={1}
            required
            value={donorCount}
            onChange={(e) => setDonorCount(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Ends ({tz})</span>
          <input type="date" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Save
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <ResultLine result={result} />
    </form>
  );
}

// ---- Actions -----------------------------------------------------------------------

const TRIGGERS: ProactiveTrigger[] = ['manual', 'checkin', 'donation', 'milestone', 'inactivity'];

function ActionsPanel({ userId, refresh }: { userId: string; refresh: () => Promise<void> }) {
  const donation = useAction(refresh);
  const milestone = useAction(refresh);
  const inactivity = useAction(refresh);
  const proactive = useAction(refresh);

  const [amount, setAmount] = useState('50');
  const [donorName, setDonorName] = useState('');
  const [donorMessage, setDonorMessage] = useState('');
  const [percent, setPercent] = useState<25 | 50 | 75 | 100>(25);
  const [trigger, setTrigger] = useState<ProactiveTrigger>('manual');

  return (
    <Panel title="Actions">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void donation.run(async () =>
            describe(
              await api.injectDonation(userId, {
                amount: Number(amount),
                donorName: donorName.trim() || undefined,
                message: donorMessage.trim() || undefined,
              }),
            ),
          );
        }}
      >
        <h3>Inject donation</h3>
        <div className="grid2">
          <label className="field">
            <span>Amount (A$)</span>
            <input type="number" min={1} step={1} required value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field">
            <span>Donor name</span>
            <input value={donorName} placeholder="optional" onChange={(e) => setDonorName(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Message</span>
          <input value={donorMessage} placeholder="optional" onChange={(e) => setDonorMessage(e.target.value)} />
        </label>
        <button className="btn btn-primary" type="submit" disabled={donation.busy}>
          Inject {amount ? fmtMoney(Number(amount)) : ''} donation
        </button>
        <ResultLine result={donation.result} />
      </form>

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void milestone.run(async () => describe(await api.injectMilestone(userId, { percent })));
        }}
      >
        <h3>Inject milestone</h3>
        <div className="inline">
          <select value={percent} onChange={(e) => setPercent(Number(e.target.value) as 25 | 50 | 75 | 100)}>
            {[25, 50, 75, 100].map((p) => (
              <option key={p} value={p}>
                {p}%
              </option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit" disabled={milestone.busy}>
            Inject milestone
          </button>
        </div>
        <ResultLine result={milestone.result} />
      </form>

      <div className="form">
        <h3>Inject inactivity</h3>
        <button
          className="btn btn-primary"
          disabled={inactivity.busy}
          onClick={() => void inactivity.run(async () => describe(await api.injectInactivity(userId)))}
        >
          Inject inactivity
        </button>
        <ResultLine result={inactivity.result} />
      </div>

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void proactive.run(async () => describe(await api.forceProactive(userId, { trigger })));
        }}
      >
        <h3>Force proactive</h3>
        <div className="inline">
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as ProactiveTrigger)}>
            {TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit" disabled={proactive.busy}>
            Force
          </button>
        </div>
        <p className="note">Bypasses guardrails (daily cap, quiet hours, 10-min cooldown after the user's last message).</p>
        <ResultLine result={proactive.result} />
      </form>
    </Panel>
  );
}

// ---- Info / schedules / tokens -----------------------------------------------------

function InfoPanel({ detail }: { detail: AdminUserDetail }) {
  const s = detail.state;
  return (
    <Panel title="Info">
      <dl className="dl">
        <Row label="Dev mode">{s.devMode ? 'on' : 'off'}</Row>
        <Row label="Model">
          <span className="mono">{s.model}</span>
        </Row>
        <Row label="Timezone">{s.timezone ?? detail.user.timezone ?? <span className="muted">unknown</span>}</Row>
        <Row label="Latest rev">{s.latestRev}</Row>
        <Row label="Proactive today">{s.proactiveSentToday}</Row>
      </dl>
    </Panel>
  );
}

function SchedulesPanel({ detail, tz }: { detail: AdminUserDetail; tz: string }) {
  const schedules = [...detail.state.schedules].sort((a, b) => a.time - b.time);
  return (
    <Panel title="Schedules">
      {schedules.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table className="table compact">
          <thead>
            <tr>
              <th>Callback</th>
              <th>Type</th>
              <th>Next run</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.callback}</td>
                <td>{s.type}</td>
                <td>
                  <Time ms={s.time} tz={tz} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function TokensPanel({ detail, tz }: { detail: AdminUserDetail; tz: string }) {
  const { chat, proactive } = detail.tokenTotals;
  const row = (label: string, t: TokenTotals) => (
    <tr>
      <td>{label}</td>
      <td className="num">{fmtInt(t.calls)}</td>
      <td className="num">{fmtInt(t.inputTokens)}</td>
      <td className="num">{fmtInt(t.outputTokens)}</td>
    </tr>
  );
  const log = [...detail.state.llmLog].sort((a, b) => b.at - a.at);
  return (
    <Panel title="Tokens">
      <table className="table compact">
        <thead>
          <tr>
            <th />
            <th className="num">Calls</th>
            <th className="num">Input</th>
            <th className="num">Output</th>
          </tr>
        </thead>
        <tbody>
          {row('Chat', chat)}
          {row('Proactive', proactive)}
        </tbody>
      </table>
      <p className="note">Summed over the capped LLM log.</p>
      <details className="part-collapsible">
        <summary>LLM log ({log.length})</summary>
        <table className="table compact">
          <thead>
            <tr>
              <th>At</th>
              <th>Kind</th>
              <th className="num">In</th>
              <th className="num">Out</th>
              <th className="num">ms</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e, i) => (
              <tr key={i} title={[e.model, e.outcome, e.note].filter(Boolean).join(' · ')}>
                <td>
                  <Time ms={e.at} tz={tz} />
                </td>
                <td>
                  {e.kind}
                  {e.trigger ? `/${e.trigger}` : ''}
                  {e.outcome && e.outcome !== 'sent' ? ` (${e.outcome})` : ''}
                </td>
                <td className="num">{fmtInt(e.inputTokens)}</td>
                <td className="num">{fmtInt(e.outputTokens)}</td>
                <td className="num">{fmtInt(e.latencyMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Panel>
  );
}

// ---- Danger zone -------------------------------------------------------------------

function DangerPanel({
  userId,
  refresh,
  onDeleted,
}: {
  userId: string;
  refresh: () => Promise<void>;
  onDeleted: (note: string) => void;
}) {
  const reset = useAction(refresh);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const doDelete = async () => {
    if (
      !window.confirm(
        `Delete user ${userId}?\n\nWipes the agent (messages, campaign, schedules) and removes it from the user list.\n\n${DEVICE_RESET_NOTE}`,
      )
    )
      return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await api.deleteUser(userId);
      if (!res.ok) throw new Error(res.message ?? 'Delete failed');
      onDeleted(`Deleted ${userId}. ${DEVICE_RESET_NOTE}`);
    } catch (e) {
      setDeleteError(errorMessage(e));
      setDeleting(false);
    }
  };

  return (
    <Panel title="Danger zone" className="danger">
      <p className="note">{DEVICE_RESET_NOTE}</p>
      <div className="form">
        <button
          className="btn btn-danger"
          disabled={reset.busy}
          onClick={() => {
            if (window.confirm(`Reset agent for ${userId}? Wipes its server-side state; the user stays listed.`))
              void reset.run(async () => describe(await api.reset(userId)));
          }}
        >
          Reset agent
        </button>
        <ResultLine result={reset.result} />
      </div>
      <div className="form">
        <button className="btn btn-danger" disabled={deleting} onClick={() => void doDelete()}>
          Delete user
        </button>
        {deleteError && <p className="result fail">{deleteError}</p>}
      </div>
    </Panel>
  );
}
