import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { COLORS, FONTS, PINSTRIPE, BORDER_1BIT, SHADOW_1BIT } from '../theme';

type Props = {
  children: React.ReactNode;
  title?: string;
  contentStyle?: ViewStyle;
};

/** The outer "window" frame — pinstripe title bar + bordered body. */
export default function Chrome({ children, title = 'Sing Anything', contentStyle }: Props) {
  return (
    <View style={styles.outer}>
      <View style={styles.frame}>
        <View style={styles.titleBar}>
          <View style={[styles.squareBtn, SHADOW_1BIT]} />
          <View style={styles.pinstripe} />
          <Text style={styles.titleText}>{title}</Text>
          <View style={styles.pinstripe} />
          <View style={[styles.squareBtn, SHADOW_1BIT, styles.squareBtnInner]}>
            <View style={styles.innerSquare} />
          </View>
        </View>
        <View style={[styles.body, contentStyle]}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    backgroundColor: COLORS.grey,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    backgroundColor: COLORS.white,
    ...BORDER_1BIT,
    ...SHADOW_1BIT,
    overflow: 'hidden',
  },
  titleBar: {
    height: 26,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 6,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.black,
  },
  squareBtn: {
    width: 12,
    height: 12,
    backgroundColor: COLORS.white,
    ...BORDER_1BIT,
  },
  squareBtnInner: { alignItems: 'center', justifyContent: 'center' },
  innerSquare: { width: 5, height: 5, ...BORDER_1BIT },
  pinstripe: {
    flex: 1,
    height: 12,
    // @ts-expect-error — RN Web accepts backgroundImage
    backgroundImage: PINSTRIPE,
  },
  titleText: {
    fontFamily: FONTS.chicago,
    fontWeight: '700',
    fontSize: 13,
    letterSpacing: -0.3,
    paddingHorizontal: 6,
    backgroundColor: COLORS.white,
  },
  body: { flex: 1, backgroundColor: COLORS.white },
});
