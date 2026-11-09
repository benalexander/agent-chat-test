import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type Props = {
  disabled?: boolean;
  onSend: (text: string) => void;
};

/** Multiline input + round send button. */
export function Composer({ disabled = false, onSend }: Props) {
  const { theme } = useUnistyles();
  const [text, setText] = useState('');
  const canSend = !disabled && text.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
  };

  return (
    <View style={styles.bar}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Message your coach"
        placeholderTextColor={theme.colors.textMuted}
        multiline
        maxLength={2000}
        aria-label="Message"
      />
      <Pressable
        onPress={send}
        disabled={!canSend}
        role="button"
        aria-label="Send"
        hitSlop={8}
        style={({ pressed }) => styles.send(canSend, pressed)}
      >
        <Ionicons name="arrow-up" size={20} color={theme.colors.onAction} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.space.sm,
    paddingHorizontal: theme.space.gutter,
    paddingVertical: theme.space.sm,
    borderTopWidth: theme.stroke.rule,
    borderTopColor: theme.colors.progressTrack,
    backgroundColor: theme.colors.background,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    paddingHorizontal: theme.space.md,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: 20,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontFamily: theme.fonts.body,
    ...theme.type.chat,
  },
  send: (enabled: boolean, pressed: boolean) => ({
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: enabled ? theme.colors.action : theme.colors.progressTrack,
    opacity: pressed ? 0.8 : 1,
  }),
}));
