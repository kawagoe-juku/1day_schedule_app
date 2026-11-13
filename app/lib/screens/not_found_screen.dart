import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../routing/app_router.dart';
import '../widgets/app_frame.dart';

/// 存在しないパスを開いたときの画面。
class NotFoundScreen extends StatelessWidget {
  const NotFoundScreen({super.key});

  static const title = 'ページが見つかりません';

  @override
  Widget build(BuildContext context) {
    return AppFrame(
      title: title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('URL が正しいか確認してください。'),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () => context.go(AppRoutes.home),
            child: const Text('ホームへ'),
          ),
        ],
      ),
    );
  }
}
