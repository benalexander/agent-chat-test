import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { formatTime } from '../lib/format';
import type { LocalMessage } from '../sync/merge';
import { Text } from './Text';

type Props = {
  message: Pick<LocalMessage, 'role' | 'text' | 'origin' | 'trigger' | 'status' | 'createdAt' | 'complete'>;
  /** In-memory bubble for a reply still streaming in. */
  streaming?: boolean;
  onRetry?: () => void;
};

/** One chat bubble: user on the right, coach on the left, proactive ones flagged. */
export function MessageBubble({ message, streaming = false, onRetry }: Props) {
  const isUser = message.role === 'user';
  const failed = message.status === 'failed';
  const pending = message.status === 'pending';
  styles.useVariants({ side: isUser ? 'user' : 'coach' });

  const bubble = (
    <View style={[styles.bubble, pending && styles.pending, failed && styles.failed]}>
      <Text variant="chat" style={styles.text}>
        {message.text || (streaming ? '…' : '')}
      </Text>
    </View>
  );

  return (
    <View style={styles.row}>
      {message.origin === 'proactive' ? (
        <View style={styles.badge}>
          <Text variant="caption" style={styles.badgeText}>
            {`PROACTIVE${message.trigger ? ` · ${message.trigger.toUpperCase()}` : ''}`}
          </Text>
        </View>
      ) : null}
      {failed && onRetry ? (
        <Pressable onPress={onRetry} role="button" aria-label="Message not sent. Tap to retry">
          {bubble}
        </Pressable>
      ) : (
        bubble
      )}
      <Text variant="caption" tone={failed ? 'danger' : 'muted'} style={styles.meta}>
        {failed
          ? 'Not sent · tap to retry'
          : pending
            ? 'Sending…'
            : streaming
              ? 'Typing…'
              : formatTime(message.createdAt)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.space.gutter,
    paddingVertical: theme.space.xs,
    gap: theme.space.xs,
    variants: {
      side: {
        user: { alignItems: 'flex-end' },
        coach: { alignItems: 'flex-start' },
      },
    },
  },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm + 2,
    borderRadius: theme.radius.bubble,
    variants: {
      side: {
        user: { backgroundColor: theme.colors.action, borderBottomRightRadius: 4 },
        coach: { backgroundColor: theme.colors.surface, borderBottomLeftRadius: 4 },
      },
    },
  },
  pending: {
    opacity: 0.6,
  },
  failed: {
    backgroundColor: theme.colors.background,
    borderWidth: 1.5,
    borderColor: theme.colors.danger,
  },
  text: {
    variants: {
      side: {
        user: { color: theme.colors.onAction },
        coach: { color: theme.colors.text },
      },
    },
  },
  badge: {
    paddingHorizontal: theme.space.sm,
    paddingVertical: 2,
    backgroundColor: theme.colors.highlight,
  },
  badgeText: {
    fontFamily: theme.fonts.bodyStrong,
    color: theme.colors.onAccent,
    letterSpacing: 0.5,
  },
  meta: {
    paddingHorizontal: theme.space.xs,
  },
}));
