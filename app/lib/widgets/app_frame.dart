import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// 全画面共通の枠（画面の見本の `.app-frame`）。
///
/// 上から、見出し（[title] と戻るボタン）・本文（[child]。縦にスクロールする）・
/// 画面下部に固定する操作（[footer]）を並べる。
/// 画面幅が広いときは、中央に寄せて枠線と余白を付ける。
class AppFrame extends StatelessWidget {
  const AppFrame({
    super.key,
    required this.title,
    required this.child,
    this.onBack,
    this.footer,
  });

  /// 見出しに出す画面名
  final String title;

  /// 指定すると、見出しの左に戻るボタンを出す
  final VoidCallback? onBack;

  /// 本文
  final Widget child;

  /// 画面下部に固定する操作（ボタンなど）
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final framed = width >= AppSizes.framedBreakpoint;
    final paddingX = AppSizes.pagePaddingX(width);
    final paddingY = AppSizes.pagePaddingY(width);
    final maxWidth = width >= AppSizes.extraWideBreakpoint
        ? AppSizes.frameMaxWidthExtraWide
        : width >= AppSizes.wideBreakpoint
        ? AppSizes.frameMaxWidthWide
        : AppSizes.frameMaxWidth;

    const borderSide = BorderSide(color: AppColors.border);

    final frame = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: EdgeInsets.symmetric(horizontal: paddingX, vertical: 4),
          decoration: const BoxDecoration(
            color: AppColors.surface,
            border: Border(bottom: borderSide),
          ),
          child: Row(
            children: [
              if (onBack != null)
                IconButton(
                  onPressed: onBack,
                  tooltip: '戻る',
                  icon: const Icon(Icons.arrow_back),
                ),
              Expanded(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    minHeight: AppSizes.tapTarget,
                  ),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Semantics(
                      header: true,
                      child: Text(
                        title,
                        style: const TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: EdgeInsets.symmetric(
              horizontal: paddingX,
              vertical: paddingY,
            ),
            child: child,
          ),
        ),
        if (footer != null)
          Container(
            padding: EdgeInsets.symmetric(
              horizontal: paddingX,
              vertical: paddingY,
            ),
            decoration: const BoxDecoration(
              color: AppColors.surface,
              border: Border(top: borderSide),
            ),
            child: footer,
          ),
      ],
    );

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(framed ? 16 : 0),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: Container(
                clipBehavior: framed ? Clip.antiAlias : Clip.none,
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  border: framed ? Border.fromBorderSide(borderSide) : null,
                  borderRadius: framed
                      ? BorderRadius.circular(AppSizes.radiusLarge)
                      : null,
                  boxShadow: framed
                      ? const [
                          BoxShadow(
                            color: Color(0x1A000000),
                            blurRadius: 24,
                            offset: Offset(0, 4),
                          ),
                        ]
                      : null,
                ),
                child: frame,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
