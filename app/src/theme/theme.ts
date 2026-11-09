/**
 * Ridgeway theme tokens, copied from ../../companion-app/src/brands (base.ts +
 * ridgeway/theme.ts) without the multi-brand machinery or decorative art.
 *
 * Token names describe a role ("action", "badge"), never a colour or a screen.
 * Chat-specific additions are marked "POC".
 */
export const ridgeway = {
  colors: {
    background: '#FFFFFF',
    text: '#000000',
    textMuted: '#3D4448',
    surfaceInverse: '#3D4448',
    onSurfaceInverse: '#FFFFFF',
    rule: '#000000',
    progressFill: '#000000',
    progressTrack: '#CBD5DC',
    highlight: '#FFCC00',
    accent: '#FF5A1F',
    accentAlt: '#FF4A1C',
    onAccent: '#000000',
    action: '#B800FF',
    onAction: '#FFFFFF',
    badge: '#B800FF',
    onBadge: '#FFFFFF',
    tabBar: '#CBD5DC',
    tabBarActive: '#FFFFFF',
    onTabBar: '#000000',
    /** POC: assistant bubbles, input fields, debug panels. */
    surface: '#EEF2F5',
    /** POC: failed sends, errors. */
    danger: '#D7263D',
  },

  /** Registered with expo-font in theme/fonts.ts. */
  fonts: {
    display: 'Sora_400Regular',
    heading: 'Sora_600SemiBold',
    body: 'Sora_400Regular',
    bodyStrong: 'Sora_700Bold',
  },

  type: {
    title: { fontSize: 26, lineHeight: 30, letterSpacing: -0.5 },
    heading: { fontSize: 17, lineHeight: 21, letterSpacing: 0 },
    /** POC: chat bubbles are a touch larger than the base 13pt body. */
    chat: { fontSize: 15, lineHeight: 21, letterSpacing: 0 },
    body: { fontSize: 13, lineHeight: 17, letterSpacing: 0 },
    caption: { fontSize: 11, lineHeight: 14, letterSpacing: 0 },
    mono: { fontSize: 11, lineHeight: 15, letterSpacing: 0 },
  },

  space: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
    gutter: 16,
  },

  radius: {
    /** Flat editorial look: square panels. */
    surface: 0,
    /** Full pill buttons. */
    control: 999,
    /** POC: chat bubbles. */
    bubble: 18,
  },

  stroke: {
    rule: 1,
  },
} as const;

export type AppTheme = typeof ridgeway;
