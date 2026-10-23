/**
 * Boomerang capture: hold the shutter, get a burst, get a loop.
 *
 * Takes BOOMERANG_FRAMES stills as fast as the device will deliver them and
 * hands the frame URIs back; the caller stitches them into a sheet (see
 * stitchBoomerangSheet in lib/bake). Nothing here knows about sprite sheets or
 * uploads -- this screen's whole job is to turn one press into an ordered
 * burst of files.
 *
 * `skipProcessing` is deliberately OFF despite being the documented way to
 * make a burst faster. It skips the native pipeline, which also means the
 * delivered bytes carry no reliable EXIF origin and arrive rotated in a
 * device-dependent way -- expo-camera's own docs say as much. normalizeForSkia
 * can correct an EXIF flag; it cannot correct bytes that are silently sideways
 * with nothing to signal it. A boomerang that plays rotated on some phones is
 * a worse bug than one that captures slower everywhere.
 *
 * The consequence to know about: capture takes as long as twelve full-pipeline
 * shutter cycles, which on a mid-range phone is longer than the ~0.8s the loop
 * plays back in. So the motion comes out somewhat sped up rather than
 * real-time. That is the same artefact the original Boomerang had, and it is
 * measurable on a real device in a way it cannot be here -- if it reads as too
 * fast, the fix is BOOMERANG_FPS, not this file.
 */

import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { BOOMERANG_FRAMES } from '../lib/boomerang';
import { hairlineWidth, radius, spacing, useTheme } from '../lib/theme';

export interface BoomerangCaptureProps {
  /** Ordered frame URIs, oldest first. Never called with fewer than 2. */
  onCaptured: (frameUris: string[]) => void;
  onCancel: () => void;
}

export function BoomerangCapture({ onCaptured, onCancel }: BoomerangCaptureProps) {
  const { colors, typography } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [captured, setCaptured] = useState(0);
  const camera = useRef<CameraView>(null);
  /** Guards against a second press landing mid-burst. */
  const busy = useRef(false);

  const capture = useCallback(async () => {
    if (busy.current || !camera.current) return;
    busy.current = true;
    setCaptured(0);
    const uris: string[] = [];
    try {
      for (let i = 0; i < BOOMERANG_FRAMES; i++) {
        const shot = await camera.current.takePictureAsync({
          // Modest quality: these become 540px cells in a sheet, so a
          // full-quality 12MP frame is bytes written and read for nothing,
          // and the write is part of what makes the burst slow.
          quality: 0.5,
          skipProcessing: false,
          shutterSound: false,
        });
        if (shot?.uri) {
          uris.push(shot.uri);
          setCaptured(uris.length);
        }
      }
    } catch {
      // A failed shutter mid-burst isn't fatal -- a short boomerang is still a
      // boomerang. Only a burst too short to loop is worth discarding.
    } finally {
      busy.current = false;
      setCaptured(0);
    }
    if (uris.length >= 2) onCaptured(uris);
  }, [onCaptured]);

  if (!permission) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.surface }]}>
        <ActivityIndicator color={colors.textSecondary} />
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.root, styles.center, { backgroundColor: colors.surface }]}>
        <Text style={[typography.body, styles.permissionText, { color: colors.text }]}>
          Kalos needs camera access to record a boomerang.
        </Text>
        <Pressable onPress={requestPermission} style={[styles.permissionButton, { backgroundColor: colors.accent }]}>
          <Text style={[typography.bodyStrong, { color: '#fff' }]}>Allow camera</Text>
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={12}>
          <Text style={[typography.body, { color: colors.textSecondary }]}>Not now</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const progress = captured / BOOMERANG_FRAMES;
  const capturing = captured > 0;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: '#000' }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={onCancel} hitSlop={12} disabled={capturing} accessibilityRole="button">
          <Text style={[typography.body, { color: '#fff' }, capturing && styles.dim]}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Boomerang</Text>
        <Pressable
          onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
          hitSlop={12}
          disabled={capturing}
          accessibilityRole="button"
          accessibilityLabel="Flip camera"
        >
          <Ionicons name="camera-reverse-outline" size={22} color="#fff" style={capturing && styles.dim} />
        </Pressable>
      </View>

      {/* Square, because a boomerang frame is square -- framing it any other
          shape here would promise a composition the sheet then centre-crops
          away. */}
      <View style={styles.previewWrap}>
        <CameraView ref={camera} style={styles.preview} facing={facing} />
        {capturing ? <View style={[styles.progress, { width: `${progress * 100}%` }]} /> : null}
      </View>

      <View style={styles.controls}>
        <Text style={[typography.caption, styles.hint]}>
          {capturing ? `${captured} of ${BOOMERANG_FRAMES}` : 'Tap to record a loop'}
        </Text>
        <Pressable
          onPress={capture}
          disabled={capturing}
          accessibilityRole="button"
          accessibilityLabel="Record boomerang"
          style={[styles.shutter, capturing && styles.shutterBusy]}
        >
          {capturing ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Ionicons name="infinite" size={30} color="#000" />
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
  permissionText: { textAlign: 'center' },
  permissionButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
  header: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    borderBottomWidth: hairlineWidth,
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '600' },
  dim: { opacity: 0.4 },
  previewWrap: { width: '100%', aspectRatio: 1, backgroundColor: '#000', overflow: 'hidden' },
  preview: { flex: 1 },
  progress: { position: 'absolute', left: 0, bottom: 0, height: 3, backgroundColor: '#fff' },
  controls: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  hint: { color: 'rgba(255,255,255,0.7)' },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterBusy: { opacity: 0.6 },
});

export default BoomerangCapture;
