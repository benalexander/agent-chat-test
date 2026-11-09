/** Coach tab: the chat. Renders from SQLite only, plus the in-memory streaming bubble. */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, RefreshControl, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { retryMessage, sendMessage } from '../chat/send';
import { Composer } from '../components/Composer';
import { MessageBubble } from '../components/MessageBubble';
import { Text } from '../components/Text';
import { COACH_POLL_MS } from '../config';
import { listMessages, maxRev } from '../db/repo';
import { useAppActive } from '../hooks/useAppActive';
import { useQuery } from '../hooks/useQuery';
import { useStreaming } from '../hooks/useStreaming';
import type { LocalMessage } from '../sync/merge';
import { setCoachVisible } from '../sync/presence';
import { markSeenUpTo, onSyncingChange, runSync } from '../sync/sync';

type Item = { kind: 'stored'; message: LocalMessage } | { kind: 'streaming'; id: string; text: string };

export default function CoachScreen() {
  const { theme } = useUnistyles();
  const { data: messages } = useQuery(listMessages, ['messages']);
  const streaming = useStreaming();
  const appActive = useAppActive();
  const [focused, setFocused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const visible = focused && appActive;

  useEffect(() => onSyncingChange(setSyncing), []);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // Presence + 10 s poll while Coach is visible in the foreground.
  useEffect(() => {
    setCoachVisible(visible);
    if (!visible) return;
    runSync({ reason: 'poll' }).catch(() => undefined);
    const timer = setInterval(() => runSync({ reason: 'poll' }).catch(() => undefined), COACH_POLL_MS);
    return () => {
      clearInterval(timer);
      setCoachVisible(false);
    };
  }, [visible]);

  // Everything on screen while visible counts as seen (clears the badge, prevents notifications).
  useEffect(() => {
    if (!visible) return;
    maxRev()
      .then((rev) => markSeenUpTo(rev))
      .catch(() => undefined);
  }, [visible, messages]);

  const items = useMemo<Item[]>(() => {
    const all = messages ?? [];
    const toItems = (list: LocalMessage[]): Item[] => list.map((m) => ({ kind: 'stored', message: m }));
    if (!streaming) return toItems(all);
    // Hide the in-memory bubble once the complete stored reply has arrived...
    if (streaming.assistantId !== null && all.some((m) => m.id === streaming.assistantId && m.complete)) {
      return toItems(all);
    }
    // ...and until then hide any partial copy a poll may have stored mid-stream.
    const stored = toItems(all.filter((m) => m.id !== streaming.assistantId));
    // Inverted list: index 0 renders at the bottom.
    return [{ kind: 'streaming', id: `streaming-${streaming.userMessageId}`, text: streaming.text }, ...stored];
  }, [messages, streaming]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await runSync({ reason: 'pull' }).catch(() => undefined);
    setRefreshing(false);
  }, []);

  const renderItem = useCallback(({ item }: { item: Item }) => {
    if (item.kind === 'streaming') {
      return (
        <MessageBubble
          streaming
          message={{
            role: 'assistant',
            text: item.text,
            origin: 'reply',
            trigger: null,
            status: 'sent',
            createdAt: Date.now(),
            complete: false,
          }}
        />
      );
    }
    const m = item.message;
    return (
      <MessageBubble
        message={m}
        streaming={m.role === 'assistant' && !m.complete}
        onRetry={m.status === 'failed' ? () => retryMessage(m.id).catch(() => undefined) : undefined}
      />
    );
  }, []);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <View style={styles.header}>
        <Text variant="title">Coach</Text>
        {syncing ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : null}
      </View>
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        inverted
        data={items}
        keyExtractor={(it) => (it.kind === 'stored' ? it.message.id : it.id)}
        renderItem={renderItem}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          messages ? (
            <View style={styles.empty}>
              <Text tone="muted">Say hi to your fundraising coach.</Text>
            </View>
          ) : undefined
        }
      />
      <Composer disabled={streaming !== null} onSend={(t) => sendMessage(t).catch(() => undefined)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: rt.insets.top + theme.space.sm,
    paddingBottom: theme.space.sm,
    paddingHorizontal: theme.space.gutter,
    borderBottomWidth: theme.stroke.rule,
    borderBottomColor: theme.colors.rule,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.space.sm,
  },
  empty: {
    alignItems: 'center',
    padding: theme.space.xl,
  },
}));
