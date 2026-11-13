import 'package:flutter/material.dart';

import '../routing/app_router.dart';
import '../widgets/app_frame.dart';
import '../widgets/placeholder_body.dart';

/// 2.2.2 ホーム／入力画面。
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  static const title = 'ホーム';

  /// 空ページの間、行動計画結果画面を開くための仮の計画 ID
  static const samplePlanId = 'sample';

  @override
  Widget build(BuildContext context) {
    return AppFrame(
      title: title,
      child: PlaceholderBody(
        task: '6.1',
        links: [
          ScreenLink('計画生成（行動計画結果へ）', AppRoutes.planResult(samplePlanId)),
          const ScreenLink('ルーティン', AppRoutes.routines),
          const ScreenLink('メモ', AppRoutes.memos),
          const ScreenLink('設定', AppRoutes.settings),
        ],
      ),
    );
  }
}
