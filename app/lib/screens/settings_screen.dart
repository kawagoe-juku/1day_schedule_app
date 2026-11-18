import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../routing/app_router.dart';
import '../widgets/app_frame.dart';
import '../widgets/placeholder_body.dart';

/// 2.2.6 アカウント・設定画面。
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  static const title = 'アカウント・設定';

  @override
  Widget build(BuildContext context) {
    return AppFrame(
      title: title,
      onBack: () => context.go(AppRoutes.home),
      child: const PlaceholderBody(
        task: '8.5',
        links: [ScreenLink('プロファイル編集', AppRoutes.profileEdit)],
        showLogout: true,
      ),
    );
  }
}
