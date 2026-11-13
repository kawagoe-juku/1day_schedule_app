import 'package:flutter/material.dart';

/// 画面の見本（docs/Alli/紙芝居html/HTML_0831/css/common.css）の配色。
abstract final class AppColors {
  static const background = Color(0xFFF5F5F5);
  static const surface = Color(0xFFFFFFFF);
  static const surfaceMuted = Color(0xFFF8F9FA);
  static const text = Color(0xFF212529);
  static const textMuted = Color(0xFF6C757D);
  static const border = Color(0xFFDEE2E6);
  static const primary = Color(0xFF343A40);
  static const primaryHover = Color(0xFF23272B);
  static const danger = Color(0xFFDC3545);
  static const disabled = Color(0xFFADB5BD);
}

/// 画面の見本の寸法。
abstract final class AppSizes {
  /// 画面枠の最大幅（スマートフォン幅）
  static const frameMaxWidth = 480.0;

  /// 画面枠の最大幅（幅 768 以上）
  static const frameMaxWidthWide = 1200.0;

  /// 画面枠の最大幅（幅 1024 以上）
  static const frameMaxWidthExtraWide = 1280.0;

  /// これ以上の幅では、画面枠のまわりに余白と枠線を付ける
  static const framedBreakpoint = 520.0;

  /// これ以上の幅では、Web 向けの横に広いレイアウトにする
  static const wideBreakpoint = 768.0;
  static const extraWideBreakpoint = 1024.0;

  static const radiusLarge = 12.0;
  static const radiusSmall = 6.0;

  /// ボタン・入力欄の最小の高さ（指で押せる大きさ）
  static const tapTarget = 44.0;

  /// ページの左右・上下の余白
  static double pagePaddingX(double width) => width >= wideBreakpoint ? 24 : 16;
  static double pagePaddingY(double width) => width >= wideBreakpoint ? 20 : 16;
}

/// アプリ全体のテーマ。画面の見本（Bootstrap 5 ＋ common.css）の見た目に合わせる。
ThemeData buildAppTheme() {
  const colorScheme = ColorScheme.light(
    primary: AppColors.primary,
    onPrimary: Colors.white,
    secondary: AppColors.textMuted,
    onSecondary: Colors.white,
    error: AppColors.danger,
    onError: Colors.white,
    surface: AppColors.surface,
    onSurface: AppColors.text,
    onSurfaceVariant: AppColors.textMuted,
    outline: AppColors.border,
    outlineVariant: AppColors.border,
  );

  final buttonShape = RoundedRectangleBorder(
    borderRadius: BorderRadius.circular(AppSizes.radiusSmall),
  );
  const buttonMinimumSize = Size(0, AppSizes.tapTarget);
  const buttonPadding = EdgeInsets.symmetric(horizontal: 12, vertical: 8);

  OutlineInputBorder inputBorder(Color color) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(AppSizes.radiusSmall),
    borderSide: BorderSide(color: color),
  );

  return ThemeData(
    colorScheme: colorScheme,
    scaffoldBackgroundColor: AppColors.background,
    dividerColor: AppColors.border,
    disabledColor: AppColors.disabled,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.surface,
      foregroundColor: AppColors.text,
      elevation: 0,
      scrolledUnderElevation: 0,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        disabledBackgroundColor: AppColors.disabled,
        minimumSize: buttonMinimumSize,
        padding: buttonPadding,
        shape: buttonShape,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.text,
        side: const BorderSide(color: AppColors.text),
        minimumSize: buttonMinimumSize,
        padding: buttonPadding,
        shape: buttonShape,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: AppColors.text,
        minimumSize: buttonMinimumSize,
        shape: buttonShape,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      border: inputBorder(AppColors.border),
      enabledBorder: inputBorder(AppColors.border),
      focusedBorder: inputBorder(AppColors.primary),
      errorBorder: inputBorder(AppColors.danger),
      focusedErrorBorder: inputBorder(AppColors.danger),
      errorStyle: const TextStyle(color: AppColors.danger, fontSize: 13),
    ),
    cardTheme: CardThemeData(
      color: AppColors.surfaceMuted,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppSizes.radiusLarge),
        side: const BorderSide(color: AppColors.border),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: AppColors.text,
    ),
  );
}
