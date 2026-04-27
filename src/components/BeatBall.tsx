// Bouncing-ball metronome.
// Renders a small dot that hops up-and-down once per beat at the phrase
// tempo. Visual cue only — the looping audio (phraseLoop.ts) is the
// timing authority. The animation runs as an Animated loop on the JS
// thread; for one ball at ~120 BPM that's <1% of a frame budget.

import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { COLORS } from '../theme';

const BOUNCE_HEIGHT = 22;
const BALL_SIZE = 12;

export default function BeatBall({
  bpm,
  active,
}: {
  bpm: number;
  active: boolean;
}) {
  const value = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      value.stopAnimation();
      value.setValue(0);
      return;
    }
    const beatMs = 60000 / Math.max(20, bpm);
    value.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: beatMs / 2,
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: beatMs / 2,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, bpm, value]);

  if (!active) return null;

  const translateY = value.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -BOUNCE_HEIGHT],
  });

  return (
    <View style={styles.track} pointerEvents="none">
      <View style={styles.floor} />
      <Animated.View style={[styles.ball, { transform: [{ translateY }] }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: BOUNCE_HEIGHT + BALL_SIZE + 4,
    width: 60,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  floor: {
    position: 'absolute',
    bottom: 0,
    width: 40,
    height: 1,
    backgroundColor: COLORS.black,
    opacity: 0.25,
  },
  ball: {
    width: BALL_SIZE,
    height: BALL_SIZE,
    borderRadius: BALL_SIZE / 2,
    backgroundColor: COLORS.black,
  },
});
