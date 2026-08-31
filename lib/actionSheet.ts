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
