import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'load_error_view.dart';

/// 取得中・取得失敗・取得済みを切り替えて表示する。
///
/// 取得中は進行中の表示、失敗時は「取得に失敗しました」と再試行ボタン（[LoadErrorView]）を
/// この部品の領域の中に出す。画面のほかの部分はそのまま使える。
///
/// ```dart
/// AsyncValueView(
///   value: ref.watch(memosProvider),
///   onRetry: () => ref.invalidate(memosProvider),
///   builder: (memos) => MemoList(memos),
/// )
/// ```
class AsyncValueView<T> extends StatelessWidget {
  const AsyncValueView({
    super.key,
    required this.value,
    required this.onRetry,
    required this.builder,
  });

  final AsyncValue<T> value;

  /// 「再試行」を押したときの処理（多くは `ref.invalidate(...)`）
  final VoidCallback onRetry;

  /// 取得できたときの表示
  final Widget Function(T data) builder;

  @override
  Widget build(BuildContext context) {
    final value = this.value;
    // 再試行で取り直している間は、前の失敗や前のデータではなく進行中を出す
    if (value.isLoading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 16),
        child: Center(
          child: CircularProgressIndicator(semanticsLabel: '読み込み中'),
        ),
      );
    }
    return switch (value) {
      AsyncData(:final value) => builder(value),
      _ => LoadErrorView(onRetry: onRetry),
    };
  }
}
