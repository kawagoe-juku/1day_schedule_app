import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../routing/app_router.dart';
import '../widgets/app_frame.dart';
import '../widgets/placeholder_body.dart';

/// 2.2.7 プロファイル編集画面。
class ProfileEditScreen extends StatelessWidget {
  const ProfileEditScreen({super.key});

  static const title = 'プロファイル編集';

  @override
  Widget build(BuildContext context) {
    return AppFrame(
      title: title,
      onBack: () => context.go(AppRoutes.settings),
      child: const PlaceholderBody(
        task: '8.5',
        links: [ScreenLink('アカウント・設定へ', AppRoutes.settings)],
      ),
    );
  }
}
