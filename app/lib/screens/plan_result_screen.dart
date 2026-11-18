import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../routing/app_router.dart';
import '../widgets/app_frame.dart';
import '../widgets/placeholder_body.dart';

/// 2.2.3 行動計画結果画面。
class PlanResultScreen extends StatelessWidget {
  const PlanResultScreen({super.key, required this.planId});

  static const title = '行動計画結果';

  /// 表示する行動計画の ID
  final String planId;

  @override
  Widget build(BuildContext context) {
    return AppFrame(
      title: title,
      onBack: () => context.go(AppRoutes.home),
      child: const PlaceholderBody(
        task: '6.2・6.3',
        links: [ScreenLink('ホームへ', AppRoutes.home)],
      ),
    );
  }
}
