import 'package:ai_schedule_app/theme/app_theme.dart';
import 'package:ai_schedule_app/widgets/async_value_view.dart';
import 'package:ai_schedule_app/widgets/form_field_frame.dart';
import 'package:ai_schedule_app/widgets/load_error_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _pump(WidgetTester tester, Widget child) => tester.pumpWidget(
  MaterialApp(
    theme: buildAppTheme(),
    home: Scaffold(body: child),
  ),
);

/// ラベル（Text.rich）を、画面に見える文字列で探す（読み上げ用の「（必須）」ではなく `*`）。
Finder _richText(String text) => find.byWidgetPredicate(
  (widget) =>
      widget is RichText &&
      widget.text.toPlainText(includeSemanticsLabels: false) == text,
);

void main() {
  group('LoadErrorView', () {
    testWidgets('「取得に失敗しました」と再試行ボタンを出し、押すと再試行する', (tester) async {
      var retried = 0;
      await _pump(tester, LoadErrorView(onRetry: () => retried++));

      expect(find.text('取得に失敗しました'), findsOneWidget);
      await tester.tap(find.widgetWithText(OutlinedButton, '再試行'));

      expect(retried, 1);
    });
  });

  group('AsyncValueView', () {
    Widget view(AsyncValue<String> value, {VoidCallback? onRetry}) =>
        AsyncValueView<String>(
          value: value,
          onRetry: onRetry ?? () {},
          builder: (data) => Text('データ：$data'),
        );

    testWidgets('取得中は進行中の表示を出す', (tester) async {
      await _pump(tester, view(const AsyncLoading()));

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('取得できたら中身を出す', (tester) async {
      await _pump(tester, view(const AsyncData('メモ')));

      expect(find.text('データ：メモ'), findsOneWidget);
      expect(find.byType(LoadErrorView), findsNothing);
    });

    testWidgets('失敗したら、その領域に再試行を出す', (tester) async {
      var retried = 0;
      await _pump(
        tester,
        Column(
          children: [
            const Text('ほかの領域'),
            view(
              AsyncError(Exception('失敗'), StackTrace.empty),
              onRetry: () => retried++,
            ),
          ],
        ),
      );

      expect(find.text('ほかの領域'), findsOneWidget);
      expect(find.text('取得に失敗しました'), findsOneWidget);
      await tester.tap(find.text('再試行'));
      expect(retried, 1);
    });
  });

  group('FormFieldFrame', () {
    testWidgets('必須の印と入力エラーを出す', (tester) async {
      await _pump(
        tester,
        const FormFieldFrame(
          label: '自宅住所',
          required: true,
          errorText: '自宅住所を入力してください',
          child: TextField(),
        ),
      );

      expect(_richText('自宅住所 *'), findsOneWidget);
      final error = tester.widget<Text>(find.text('自宅住所を入力してください'));
      expect(error.style?.color, AppColors.danger);
    });

    testWidgets('入力欄に、読み上げ用の名前（ラベルと必須かどうか）が付く', (tester) async {
      final handle = tester.ensureSemantics();
      await _pump(
        tester,
        const Column(
          children: [
            FormFieldFrame(label: '自宅住所', required: true, child: TextField()),
            FormFieldFrame(label: 'よく使う駅', child: TextField()),
          ],
        ),
      );

      // 入力欄そのもの（テキスト入力として読み上げられる要素）に名前が付いている
      final fields = find.byType(TextField);
      expect(
        tester.getSemantics(fields.at(0)),
        isSemantics(label: '自宅住所（必須）', isTextField: true),
      );
      expect(
        tester.getSemantics(fields.at(1)),
        isSemantics(label: 'よく使う駅', isTextField: true),
      );
      // 見た目のラベルは別に読み上げない（二重に読まれない）
      expect(find.bySemanticsLabel('自宅住所（必須）'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('エラーがなければ出さない', (tester) async {
      await _pump(
        tester,
        const FormFieldFrame(label: 'よく使う駅', child: TextField()),
      );

      expect(find.byType(FieldErrorText), findsNothing);
      expect(_richText('よく使う駅'), findsOneWidget);
    });
  });
}
