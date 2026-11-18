import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../routing/app_router.dart';
import '../widgets/app_frame.dart';
import '../widgets/placeholder_body.dart';

/// 2.2.4 ルーティン設定画面。
class RoutinesScreen extends StatelessWidget {
  const RoutinesScreen({super.key});

  static const title = 'ルーティン設定';

  @override
  Widget build(BuildContext context) {
    return AppFrame(
      title: title,
      onBack: () => context.go(AppRoutes.home),
      child: const PlaceholderBody(
        task: '7.3',
        links: [ScreenLink('ホームへ', AppRoutes.home)],
      ),
    );
  }
}
