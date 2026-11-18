import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'app.dart';

void main() {
  // URL を /#/routines ではなく /routines の形にする。
  // 再読み込み時は、CloudFront が拡張子のないパスを index.html に読み替える（infra の web-stack）。
  usePathUrlStrategy();
  runApp(
    ProviderScope(
      // 失敗した取得を自動でやり直さない（画面の「再試行」ボタンでやり直す）
      retry: (retryCount, error) => null,
      child: const App(),
    ),
  );
}
