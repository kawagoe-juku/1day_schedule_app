import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// データの取得に失敗したときの表示。メッセージと「再試行」ボタンを、その領域の中に出す。
class LoadErrorView extends StatelessWidget {
  const LoadErrorView({
    super.key,
    required this.onRetry,
    this.message = defaultMessage,
  });

  static const defaultMessage = '取得に失敗しました';
  static const retryLabel = '再試行';

  final String message;

  /// 「再試行」を押したときの処理
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(
            message,
            style: const TextStyle(color: AppColors.danger, fontSize: 14),
          ),
        ),
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: onRetry,
          style: OutlinedButton.styleFrom(
            foregroundColor: AppColors.textMuted,
            side: const BorderSide(color: AppColors.textMuted),
            minimumSize: const Size(0, 36),
          ),
          child: const Text(retryLabel),
        ),
      ],
    );
  }
}
