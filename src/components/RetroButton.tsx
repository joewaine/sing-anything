import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { BORDER_1BIT, COLORS, FONTS, SHADOW_1BIT } from '../theme';

type Props = {
  label: string;
  onPress: () => void;
  variant?: 'light' | 'dark' | 'danger';
  icon?: 'play' | null;
  style?: ViewStyle;
  size?: 'sm' | 'md' | 'lg';
};

/** 1-bit Mac-style button: border + shadow, presses into translate(1,1). */
export default function RetroButton({
  label,
  onPress,
  variant = 'light',
  icon = null,
  size = 'md',
  style,
}: Props) {
  const sizing = SIZES[size];
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => {
        const bg =
          variant === 'danger'
            ? '#ff3b30'
            : variant === 'dark' || pressed
              ? COLORS.black
              : COLORS.white;
        const fg =
          variant === 'danger'
            ? COLORS.white
            : variant === 'dark' || pressed
              ? COLORS.white
              : COLORS.black;
        return (
          <View
            style={[
              styles.btn,
              sizing.btn,
              { backgroundColor: bg },
              pressed ? styles.pressed : SHADOW_1BIT,
              style,
            ]}
          >
            {icon === 'play' && (
              <View
                style={[
                  styles.playIcon,
                  { borderLeftColor: fg },
                ]}
              />
            )}
            <Text style={[styles.label, sizing.label, { color: fg }]}>{label}</Text>
          </View>
        );
      }}
    </Pressable>
  );
}

const SIZES = {
  sm: { btn: { paddingVertical: 4, paddingHorizontal: 10, gap: 6 }, label: { fontSize: 12 } },
  md: { btn: { paddingVertical: 8, paddingHorizontal: 16, gap: 8 }, label: { fontSize: 14 } },
  lg: { btn: { paddingVertical: 10, paddingHorizontal: 24, gap: 10 }, label: { fontSize: 17 } },
} as const;

const styles = StyleSheet.create({
  btn: {
    ...BORDER_1BIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    transform: [{ translateX: 1 }, { translateY: 1 }],
  },
  label: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  playIcon: {
    width: 0,
    height: 0,
    borderTopWidth: 5,
    borderTopColor: 'transparent',
    borderBottomWidth: 5,
    borderBottomColor: 'transparent',
    borderLeftWidth: 8,
  },
});
