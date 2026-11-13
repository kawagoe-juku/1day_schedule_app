import 'package:flutter/material.dart';

import '../widgets/app_frame.dart';
import '../widgets/placeholder_body.dart';

/// 2.2.1 初回オンボーディング画面（6ステップ）。
class OnboardingScreen extends StatelessWidget {
  const OnboardingScreen({super.key});

  static const title = '初回設定';

  @override
  Widget build(BuildContext context) {
    return AppFrame(
      title: title,
      child: const PlaceholderBody(task: '4.5', links: [], showLogout: true),
    );
  }
}
