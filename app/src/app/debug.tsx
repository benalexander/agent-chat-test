/** Debug tab: inject events, inspect the agent, and measure push and background notifications. */
import type { DebugActionResponse, DebugState, InjectMilestoneRequest } from '@agent-chat/shared';
import * as BackgroundTask from 'expo-background-task';
import * as Clipboard from 'expo-clipboard';
import * as Notifications from 'expo-notifications';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { debugApi } from '../api/client';
import { KeyValue, Section } from '../components/Section';
import { PillButton } from '../components/PillButton';
import { Text } from '../components/Text';
import { API_URL } from '../config';
import { deleteLocalDb } from '../db/db';
import { KV, kvGet, kvGetNumber, listBgRuns, listDeliveries } from '../db/repo';
import { useQuery } from '../hooks/useQuery';
import { emit } from '../lib/events';
import { deviceTimezone, errorMessage, formatDateTime, formatDuration } from '../lib/format';
import { getUserId } from '../lib/identity';
import { runBackgroundSync } from '../sync/background';
import { registerPushToken, type PushSetup } from '../sync/push';
import { delayStats } from '../sync/merge';
import { runSync } from '../sync/sync';

const DAY_MS = 24 * 3600_000;
const QUICK_AMOUNTS = [5, 20, 50, 100];
const MILESTONES: InjectMilestoneRequest['percent'][] = [25, 50, 75, 100];

async function loadLocal() {
  const [runs, deliveries, lastRev, lastSeenRev, bgSetup, pushSetup, userId, perm] = await Promise.all([
    listBgRuns(),
    listDeliveries(),
    kvGetNumber(KV.lastRev),
    kvGetNumber(KV.lastSeenRev),
    kvGet(KV.backgroundSetup),
    kvGet(KV.pushSetup),
    getUserId(),
    Notifications.getPermissionsAsync(),
  ]);
  const sourceByRun = new Map(runs.map((r) => [r.id, r.source]));
  const bgDeliveries = deliveries.filter((d) => d.bgRunId !== null && sourceByRun.get(d.bgRunId) === 'background_task');
  const now = Date.now();
  const bgRuns = runs.filter((r) => r.source === 'background_task');
  return {
    runs,
    deliveries,
    lastRev,
    lastSeenRev,
    bgSetup: bgSetup ? (JSON.parse(bgSetup) as { at: number; note: string }) : null,
    pushSetup: pushSetup ? (JSON.parse(pushSetup) as PushSetup) : null,
    userId,
    permission: {
      status: perm.status,
      granted: perm.granted,
      iosStatus: perm.ios?.status ?? null,
      canAskAgain: perm.canAskAgain,
    },
    stats: {
      background: delayStats(bgDeliveries.map((d) => d.delayMs)),
      push: delayStats(deliveries.filter((d) => d.source === 'push').map((d) => d.delayMs)),
      all: delayStats(deliveries.filter((d) => d.source === 'local').map((d) => d.delayMs)),
      bgRunsLast24h: bgRuns.filter((r) => now - r.wokeAt < DAY_MS).length,
      bgRunsTotal: bgRuns.length,
    },
  };
}

const IOS_STATUS = ['not determined', 'denied', 'authorized', 'provisional', 'ephemeral'];

export default function DebugScreen() {
  const { theme } = useUnistyles();
  const { data: local, reload: reloadLocal } = useQuery(loadLocal, ['bg_runs', 'deliveries', 'kv']);
  const [server, setServer] = useState<(DebugState & { fetchedAt: number }) | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [amount, setAmount] = useState('25');

  const loadServer = useCallback(async () => {
    try {
      setServer({
        ...(await debugApi.state({ timeoutMs: 15_000 })),
        fetchedAt: Date.now(),
      });
      setServerError(null);
    } catch (e) {
      setServerError(errorMessage(e));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadServer();
      reloadLocal();
    }, [loadServer, reloadLocal]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadServer(), runSync({ reason: 'pull' })]);
    reloadLocal();
    setRefreshing(false);
  }, [loadServer, reloadLocal]);

  /** Runs a debug action, shows its result, then refreshes server state and messages. */
  const act = useCallback(
    async (key: string, label: string, fn: () => Promise<DebugActionResponse | string>) => {
      setBusy(key);
      try {
        const res = await fn();
        const text =
          typeof res === 'string'
            ? res
            : `${res.ok ? 'ok' : 'failed'}${res.outcome ? ` · ${res.outcome}` : ''}${res.message ? ` · ${res.message}` : ''}`;
        setLastAction(`${label}: ${text}`);
      } catch (e) {
        setLastAction(`${label}: error · ${errorMessage(e)}`);
      } finally {
        setBusy(null);
        loadServer();
        runSync({ reason: 'pull' }).catch(() => undefined);
      }
    },
    [loadServer],
  );

  const resetAll = () =>
    Alert.alert(
      'Reset agent + local DB?',
      'Deletes the server conversation and campaign state, and the local database.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () =>
            act('reset', 'Reset', async () => {
              const res = await debugApi.reset();
              await deleteLocalDb();
              emit('messages', 'kv', 'bg_runs', 'deliveries');
              return res;
            }),
        },
      ],
    );

  const exportJson = useMemo(
    () => () =>
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          userId: local?.userId,
          timezone: deviceTimezone(),
          apiUrl: API_URL,
          permission: local?.permission,
          backgroundSetup: local?.bgSetup,
          pushSetup: local?.pushSetup,
          stats: local?.stats,
          bgRuns: local?.runs,
          deliveries: local?.deliveries,
          server,
        },
        null,
        2,
      ),
    [local, server],
  );

  const c = server?.campaign;
  const pct = c ? Math.round((c.raised / c.target) * 100) : 0;
  const daysLeft = c && server ? Math.max(0, Math.ceil((c.endsAt - server.fetchedAt) / DAY_MS)) : 0;
  const s = local?.stats.background;
  const ps = local?.stats.push;

  return (
    <View style={styles.screen}>
      {/* Fixed header (outside the ScrollView) so content never scrolls under the status bar. */}
      <View style={styles.header}>
        <Text variant="title">Debug</Text>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {lastAction ? (
          <View style={styles.banner}>
            <Text variant="caption" tone="inverse">
              {lastAction}
            </Text>
          </View>
        ) : null}

        <Section title="Inject events">
          <View style={styles.row}>
            <Text tone="muted">A$</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              keyboardType="number-pad"
              placeholder="Amount"
              placeholderTextColor={theme.colors.textMuted}
              aria-label="Donation amount"
            />
            <PillButton
              label="Donate"
              busy={busy === 'donation'}
              disabled={!(Number(amount) > 0)}
              onPress={() =>
                act('donation', `Donation A$${amount}`, () => debugApi.donation({ amount: Math.round(Number(amount)) }))
              }
            />
          </View>
          <View style={styles.wrap}>
            {QUICK_AMOUNTS.map((a) => (
              <PillButton
                key={a}
                kind="outline"
                label={`A$${a}`}
                busy={busy === `donation-${a}`}
                onPress={() => act(`donation-${a}`, `Donation A$${a}`, () => debugApi.donation({ amount: a }))}
              />
            ))}
          </View>
          <Text variant="caption" tone="muted">
            Milestone
          </Text>
          <View style={styles.wrap}>
            {MILESTONES.map((p) => (
              <PillButton
                key={p}
                kind="outline"
                label={`${p}%`}
                busy={busy === `milestone-${p}`}
                onPress={() => act(`milestone-${p}`, `Milestone ${p}%`, () => debugApi.milestone({ percent: p }))}
              />
            ))}
          </View>
          <View style={styles.wrap}>
            <PillButton
              kind="outline"
              label="Inactivity"
              busy={busy === 'inactivity'}
              onPress={() => act('inactivity', 'Inactivity', () => debugApi.inactivity())}
            />
            <PillButton
              label="Force proactive"
              busy={busy === 'proactive'}
              onPress={() => act('proactive', 'Force proactive', () => debugApi.proactive({ trigger: 'manual' }))}
            />
          </View>
        </Section>

        <Section title="Campaign">
          {serverError ? <Text tone="danger">{serverError}</Text> : null}
          {c ? (
            <>
              <KeyValue label={c.name} value={c.charity} />
              <KeyValue label="Raised" value={`A$${c.raised} / A$${c.target} (${pct}%)`} />
              <KeyValue label="Donors" value={c.donorCount} />
              <KeyValue label="Days left" value={daysLeft} />
              <KeyValue label="Milestones hit" value={c.milestonesHit.join(', ') || '–'} />
              <KeyValue label="Last activity" value={formatDateTime(c.lastActivityAt)} />
              {c.donations
                .slice(-5)
                .reverse()
                .map((d) => (
                  <Text key={d.id} variant="mono">
                    {`${formatDateTime(d.at)}  A$${d.amount}  ${d.donorName}${d.message ? ` – ${d.message}` : ''}`}
                  </Text>
                ))}
            </>
          ) : !serverError ? (
            <Text tone="muted">Loading…</Text>
          ) : null}
        </Section>

        <Section title="Agent">
          <KeyValue label="Model" value={server?.model ?? '–'} />
          <KeyValue label="Dev mode" value={server ? String(server.devMode) : '–'} />
          <KeyValue label="Server timezone" value={server?.timezone ?? '–'} />
          <KeyValue label="Proactive today" value={server?.proactiveSentToday ?? '–'} />
          <KeyValue label="Server latestRev" value={server?.latestRev ?? '–'} />
          <KeyValue
            label="Local lastRev / lastSeenRev"
            value={local ? `${local.lastRev} / ${local.lastSeenRev}` : '–'}
          />
          {server?.schedules.map((sch) => (
            <Text
              key={sch.id}
              variant="mono"
            >{`⏱ ${sch.callback} · ${sch.type} · ${formatDateTime(sch.time * (sch.time < 1e12 ? 1000 : 1))}`}</Text>
          ))}
        </Section>

        <Section title="LLM calls">
          {server?.llmLog.length ? (
            server.llmLog
              .slice(0, 15)
              .map((l, i) => (
                <Text key={`${l.at}-${i}`} variant="mono">
                  {`${formatDateTime(l.at)} ${l.kind}${l.trigger ? `/${l.trigger}` : ''} ${l.inputTokens}→${l.outputTokens} tok ${formatDuration(l.latencyMs)}${l.outcome ? ` ${l.outcome}` : ''}${l.note ? ` (${l.note})` : ''}`}
                </Text>
              ))
          ) : (
            <Text tone="muted">None yet</Text>
          )}
        </Section>

        <Section title="Proactive log">
          {server?.proactiveLog.length ? (
            server.proactiveLog
              .slice(0, 15)
              .map((p, i) => (
                <Text key={`${p.at}-${i}`} variant="mono">
                  {`${formatDateTime(p.at)} ${p.trigger} → ${p.outcome}${p.reason ? ` (${p.reason})` : ''}`}
                </Text>
              ))
          ) : (
            <Text tone="muted">None yet</Text>
          )}
        </Section>

        <Section title="Push notifications">
          <KeyValue label="Device" value={local?.pushSetup?.note ?? '–'} />
          <KeyValue
            label="Server token"
            value={server ? (server.push.tokenTail ? `…${server.push.tokenTail}` : 'none') : '–'}
          />
          <KeyValue
            label="Delay (push) median / p90 / max"
            value={ps ? `${formatDuration(ps.medianMs)} / ${formatDuration(ps.p90Ms)} / ${formatDuration(ps.maxMs)}` : '–'}
          />
          <KeyValue label="Pushes measured" value={local ? String(ps?.count ?? 0) : '–'} />
          <View style={styles.row}>
            <PillButton
              kind="outline"
              label="Register token"
              busy={busy === 'pushreg'}
              onPress={() =>
                act('pushreg', 'Register push token', async () => {
                  const r = await registerPushToken();
                  return r.note;
                })
              }
            />
            <PillButton
              label="Send test push"
              busy={busy === 'pushtest'}
              onPress={() => act('pushtest', 'Test push', () => debugApi.pushTest())}
            />
          </View>
          <Text variant="caption" tone="muted">
            Delay = when iOS delivered the push − when the server created the message. Measured when you open the
            app (from Notification Centre), tap a push, or receive one in the foreground; pushes swiped away are
            missed. Background it after tapping “Send test push” to see the banner.
          </Text>
          {server?.push.log.length ? (
            server.push.log.slice(0, 15).map((p, i) => (
              <Text key={`${p.at}-${i}`} variant="mono" tone={p.ticket === 'error' || p.receipt === 'error' ? 'danger' : undefined}>
                {`${formatDateTime(p.at)} ${p.kind} ticket ${p.ticket}${p.receipt ? ` · receipt ${p.receipt}` : ''}${p.error ? ` · ${p.error}` : ''}`}
              </Text>
            ))
          ) : (
            <Text tone="muted">No pushes yet</Text>
          )}
        </Section>

        <Section
          title="Background notifications"
          right={
            <PillButton
              kind="outline"
              label="Copy as JSON"
              onPress={async () => {
                await Clipboard.setStringAsync(exportJson());
                setLastAction('Copied debug JSON to clipboard');
              }}
            />
          }
        >
          <KeyValue
            label="Permission"
            value={
              local
                ? `${local.permission.status}${local.permission.iosStatus !== null ? ` (iOS: ${IOS_STATUS[local.permission.iosStatus] ?? local.permission.iosStatus})` : ''}`
                : '–'
            }
          />
          {local && !local.permission.granted ? (
            <PillButton
              kind="outline"
              label={local.permission.canAskAgain ? 'Request permission' : 'Denied – enable in Settings'}
              disabled={!local.permission.canAskAgain}
              onPress={async () => {
                await Notifications.requestPermissionsAsync({
                  ios: { allowAlert: true, allowSound: true },
                });
                reloadLocal();
              }}
            />
          ) : null}
          <KeyValue label="Task" value={local?.bgSetup?.note ?? '–'} />
          <KeyValue
            label="Background runs, last 24 h"
            value={local ? `${local.stats.bgRunsLast24h} (total ${local.stats.bgRunsTotal})` : '–'}
          />
          <KeyValue
            label="Delay (bg) median / p90 / max"
            value={s ? `${formatDuration(s.medianMs)} / ${formatDuration(s.p90Ms)} / ${formatDuration(s.maxMs)}` : '–'}
          />
          <KeyValue
            label="Notified messages (bg / all)"
            value={local ? `${s?.count ?? 0} / ${local.stats.all.count}` : '–'}
          />
          <PillButton
            label="Run background sync now"
            busy={busy === 'bg'}
            onPress={() =>
              act('bg', 'Background sync', async () => {
                const r = await runBackgroundSync('manual');
                return `fetched ${r.fetched}, notified ${r.notified}${r.error ? ` · ${r.error}` : ''}`;
              })
            }
          />
          {__DEV__ ? (
            <PillButton
              kind="outline"
              label="Trigger task worker (debug build)"
              busy={busy === 'trigger'}
              onPress={() =>
                act('trigger', 'Trigger task worker', async () => {
                  // Native side returns void, so the result is always falsy: check the runs list below
                  // for a new "bg [active]" row instead.
                  await BackgroundTask.triggerTaskWorkerForTestingAsync();
                  return 'requested; a "bg" run should appear below';
                })
              }
            />
          ) : null}
          <Text variant="caption" tone="muted">
            Runs the task&apos;s code path now (logged as “manual”, excluded from bg stats). It notifies even in the
            foreground; switch to this tab first so Coach doesn&apos;t mark messages seen.
          </Text>
          {local?.runs.slice(0, 30).map((r) => (
            <Text key={r.id} variant="mono" tone={r.error ? 'danger' : undefined}>
              {`${formatDateTime(r.wokeAt)} ${r.source === 'manual' ? 'manual' : 'bg'} [${r.appState}] fetched ${r.fetched} notified ${r.notified}${r.finishedAt === null ? ' · did not finish' : ` · ${formatDuration(r.finishedAt - r.wokeAt)}`}${r.error ? ` · ${r.error}` : ''}`}
            </Text>
          ))}
        </Section>

        <Section title="Device">
          <KeyValue label="User id" value={local?.userId ?? '–'} />
          <KeyValue label="Timezone" value={deviceTimezone()} />
          <KeyValue label="API" value={API_URL} />
        </Section>

        <Section title="Danger zone">
          <PillButton kind="danger" label="Reset agent + local DB" busy={busy === 'reset'} onPress={resetAll} />
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: theme.space.sm,
    paddingBottom: theme.space.xxl,
  },
  header: {
    paddingTop: rt.insets.top + theme.space.sm,
    paddingBottom: theme.space.sm,
    paddingHorizontal: theme.space.gutter,
    borderBottomWidth: theme.stroke.rule,
    borderBottomColor: theme.colors.rule,
  },
  banner: {
    marginHorizontal: theme.space.gutter,
    marginBottom: theme.space.sm,
    padding: theme.space.sm,
    backgroundColor: theme.colors.surfaceInverse,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.sm,
  },
  input: {
    flex: 1,
    minHeight: 36,
    paddingHorizontal: theme.space.md,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontFamily: theme.fonts.body,
    ...theme.type.chat,
  },
}));
