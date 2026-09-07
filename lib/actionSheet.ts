import { ActionSheetIOS, Alert, Platform } from 'react-native';

/** A single destructive action behind a native confirm sheet/alert. */
export function confirmDestructive(title: string, actionLabel: string, onConfirm: () => void) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: ['Cancel', actionLabel], destructiveButtonIndex: 1, cancelButtonIndex: 0 },
      (index) => {
        if (index === 1) onConfirm();
      }
    );
  } else {
    Alert.alert(title, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: actionLabel, style: 'destructive', onPress: onConfirm },
    ]);
  }
}

export interface ActionSheetOption {
  label: string;
  onPress: () => void;
  /** Renders in the platform's "this is dangerous" style (red on iOS). */
  destructive?: boolean;
}

/** A menu of several actions behind a native sheet/alert, e.g. a post's "…" button. */
export function showActionSheet(title: string, options: ActionSheetOption[]) {
  if (Platform.OS === 'ios') {
    const labels = ['Cancel', ...options.map((o) => o.label)];
    const destructiveIndex = options.findIndex((o) => o.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: labels,
        cancelButtonIndex: 0,
        destructiveButtonIndex: destructiveIndex >= 0 ? destructiveIndex + 1 : undefined,
      },
      (index) => {
        if (index > 0) options[index - 1]!.onPress();
      }
    );
  } else {
    Alert.alert(title, undefined, [
      ...options.map((o) => ({
        text: o.label,
        style: o.destructive ? ('destructive' as const) : undefined,
        onPress: o.onPress,
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }
}
