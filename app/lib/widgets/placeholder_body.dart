import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/auth_service.dart';
import '../auth/session_controller.dart';
import '../theme/app_theme.dart';

/// 空ページから別の画面へ移るためのリンク。
class ScreenLink {
  const ScreenLink(this.label, this.location);

  /// ボタンの表示名
  final String label;

  /// 移動先のパス
  final String location;
}

/// 中身をまだ作っていない画面の本文。どのタスクで作るかと、移動先のボタンを出す。
///
/// 各画面を実装したら、その画面からは取り除く。
class PlaceholderBody extends ConsumerWidget {
  const PlaceholderBody({
    super.key,
    required this.task,
    required this.links,
    this.showLogout = false,
  });

  /// この画面を実装する WBS のタスク番号（例：`4.3`）
  static const logoutLabel = 'ログアウト';

  final String task;

  final List<ScreenLink> links;

  /// true なら「ログアウト」ボタンを出す
  final bool showLogout;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'この画面は未実装です（WBS $task で実装）',
          style: const TextStyle(color: AppColors.textMuted),
        ),
        const SizedBox(height: 16),
        for (final link in links)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: OutlinedButton(
              onPressed: () => context.go(link.location),
              child: Text(link.label, textAlign: TextAlign.center),
            ),
          ),
        if (showLogout)
          OutlinedButton(
            onPressed: () async {
              final messenger = ScaffoldMessenger.of(context);
              try {
                await ref.read(sessionControllerProvider.notifier).signOut();
              } on AuthFailure catch (failure) {
                messenger.showSnackBar(
                  SnackBar(content: Text(failure.message)),
                );
              }
            },
            child: const Text(logoutLabel),
          ),
      ],
    );
  }
}
