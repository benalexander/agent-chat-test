import Ionicons from '@expo/vector-icons/Ionicons';
import * as Notifications from 'expo-notifications';
import { IosAuthorizationStatus } from 'expo-notifications';
import { useFonts } from 'expo-font';
import { router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { TabList, Tabs, TabSlot, TabTrigger } from 'expo-router/ui';
import { useEffect } from 'react';
import { AppState, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { TabBarContainer, TabButton } from '../components/TabBar';
import { KV, kvGet, kvSet } from '../db/repo';
import { useUnread } from '../hooks/useUnread';
import { registerBackgroundSync } from '../sync/background';
import { parsePushData } from '../sync/merge';
import { recordNotification, recordPresentedNotifications, registerPushToken } from '../sync/push';
import { runSync } from '../sync/sync';
import { fonts } from '../theme/fonts';

SplashScreen.preventAutoHideAsync();

/** See ../../companion-app: TabSlot needs to shrink so the tab bar stays on screen. */
const slotLayout = { flexGrow: 1, flexShrink: 1, flexBasis: 0 } as const;

/** First launch only: ask for notification permission (no onboarding screen). */
async function requestNotificationsOnce() {
  if (await kvGet(KV.notifPromptShown)) return;
  await kvSet(KV.notifPromptShown, String(Date.now()));
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'undetermined' || current.ios?.status === IosAuthorizationStatus.NOT_DETERMINED) {
    await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } });
  }
}

function openCoach() {
  router.navigate('/');
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ ...fonts, ...Ionicons.font });
  const unread = useUnread();

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  // Foreground lifecycle: sync on every real foreground; register the
  // background task once per runtime. iOS can also mount this layout during a
  // background launch, so only act on 'active'.
  useEffect(() => {
    let registered = false;
    const onActive = () => {
      if (!registered) {
        registered = true;
        registerBackgroundSync().catch(() => undefined);
        requestNotificationsOnce()
          .catch(() => undefined)
          .then(registerPushToken)
          .catch(() => undefined);
      }
      runSync({ reason: 'foreground' }).catch(() => undefined);
      recordPresentedNotifications().catch(() => undefined);
    };
    if (AppState.currentState === 'active') onActive();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') onActive();
    });
    return () => sub.remove();
  }, []);

  // Tapping a notification opens Coach (cold start and warm).
  useEffect(() => {
    // Cold start from a notification already lands on Coach (the initial route),
    // so just consume the stored response rather than navigating before mount.
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      recordNotification(last.notification).catch(() => undefined);
      Notifications.clearLastNotificationResponse();
    }
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      recordNotification(r.notification).catch(() => undefined);
      openCoach();
      Notifications.clearLastNotificationResponse();
    });
    // A push arriving while the app is running: record it and pull the message in.
    const received = Notifications.addNotificationReceivedListener((n) => {
      if (!parsePushData(n.request.content.data)) return;
      recordNotification(n).catch(() => undefined);
      runSync({ reason: 'push' }).catch(() => undefined);
    });
    return () => {
      sub.remove();
      received.remove();
    };
  }, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <Tabs>
        <TabSlot style={slotLayout} />
        <TabList asChild>
          <TabBarContainer>
            <TabTrigger name="index" href="/" asChild>
              <TabButton icon="chatbubbles" label="Coach" badgeCount={unread} />
            </TabTrigger>
            <TabTrigger name="debug" href="/debug" asChild>
              <TabButton icon="construct" label="Debug" />
            </TabTrigger>
          </TabBarContainer>
        </TabList>
      </Tabs>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
}));
