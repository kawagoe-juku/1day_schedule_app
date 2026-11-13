import 'package:ai_schedule_app/routing/app_router.dart';
import 'package:ai_schedule_app/widgets/app_frame.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// 起動中のアプリの画面遷移（URL を直接開く操作の代わりに使う）。
void openLocation(WidgetTester tester, String location) {
  final container = ProviderScope.containerOf(
    tester.element(find.byType(AppFrame)),
  );
  container.read(routerProvider).go(location);
}

void main() {
  testWidgets('起動するとホームを表示する', (tester) async {
    await pumpApp(tester);

    expectScreen('ホーム');
  });

  testWidgets('ホームから各画面へ移動して、戻るボタンで戻れる', (tester) async {
    await pumpApp(tester);

    const destinations = {
      '計画生成（行動計画結果へ）': '行動計画結果',
      'ルーティン': 'ルーティン設定',
      'メモ': 'メモ・買い物リスト',
      '設定': 'アカウント・設定',
    };
    for (final MapEntry(key: button, value: screen) in destinations.entries) {
      await tapButton(tester, button);
      expectScreen(screen);

      await tester.tap(find.byTooltip('戻る'));
      await tester.pumpAndSettle();
      expectScreen('ホーム');
    }
  });

  testWidgets('設定からプロファイル編集へ移動して戻れる', (tester) async {
    await pumpApp(tester);

    await tapButton(tester, '設定');
    await tapButton(tester, 'プロファイル編集');
    expectScreen('プロファイル編集');

    await tester.tap(find.byTooltip('戻る'));
    await tester.pumpAndSettle();
    expectScreen('アカウント・設定');
  });

  testWidgets('存在しないパスでは「ページが見つかりません」を表示し、ホームへ戻れる', (tester) async {
    await pumpApp(tester);

    openLocation(tester, '/no-such-page');
    await tester.pumpAndSettle();
    expectScreen('ページが見つかりません');

    await tester.tap(find.widgetWithText(FilledButton, 'ホームへ'));
    await tester.pumpAndSettle();
    expectScreen('ホーム');
  });

  testWidgets('Web 幅（1280）でもはみ出さずに表示できる', (tester) async {
    await pumpApp(tester, width: 1280);

    expectScreen('ホーム');
    expect(tester.takeException(), isNull);
  });
}
