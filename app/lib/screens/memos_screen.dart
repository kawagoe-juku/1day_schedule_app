import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../routing/app_router.dart';
import '../widgets/app_frame.dart';
import '../widgets/placeholder_body.dart';

/// 2.2.5 メモ・買い物リスト画面。
class MemosScreen extends StatelessWidget {
  const MemosScreen({super.key});

  static const title = 'メモ・買い物リスト';

  @override
  Widget build(BuildContext context) {
    return AppFrame(
      title: title,
      onBack: () => context.go(AppRoutes.home),
      child: const PlaceholderBody(
        task: '7.4',
        links: [ScreenLink('ホームへ', AppRoutes.home)],
      ),
    );
  }
}
