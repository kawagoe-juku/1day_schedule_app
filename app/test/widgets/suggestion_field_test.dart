import 'dart:async';

import 'package:ai_schedule_app/widgets/load_error_view.dart';
import 'package:ai_schedule_app/widgets/suggestion_field.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// 候補の取得の代用品。呼ばれた検索文字を残し、応答はテストから返す。
class _FakeSearch {
  final queries = <String>[];
  final _pending = <String, Completer<List<String>>>{};

  Future<List<String>> call(String query) {
    queries.add(query);
    return (_pending[query] = Completer<List<String>>()).future;
  }

  void respond(String query, List<String> items) =>
      _pending[query]!.complete(items);

  void fail(String query) => _pending[query]!.completeError(StateError('失敗'));
}

const _fieldKey = Key('field');

Future<({TextEditingController controller, List<String> selected})> _pump(
  WidgetTester tester,
  _FakeSearch search, {
  String initialText = '',
  bool searchOnFocus = false,
  int maxQueryLength = SuggestionField.defaultMaxQueryLength,
}) async {
  final controller = TextEditingController(text: initialText);
  addTearDown(controller.dispose);
  final selected = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuggestionField<String>(
          fieldKey: _fieldKey,
          controller: controller,
          semanticLabel: '自宅住所（必須）',
          search: search.call,
          itemLabel: (item) => item,
          searchOnFocus: searchOnFocus,
          maxQueryLength: maxQueryLength,
          onSelected: (item) {
            selected.add(item);
            controller.text = item;
          },
        ),
      ),
    ),
  );
  return (controller: controller, selected: selected);
}

/// 入力して、取得が始まるまで待つ。
Future<void> _type(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(_fieldKey), text);
  await tester.pump(suggestionDebounce);
}

bool _fieldHasFocus(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(_fieldKey)).focusNode!.hasFocus;

void main() {
  testWidgets('応答が前後して届いても、最後の入力の候補だけを出す', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search);
    await _type(tester, '東京');
    await _type(tester, '東京都');
    expect(search.queries, ['東京', '東京都']);

    // 新しいほうが先に届き、古いほうが後から届く
    search.respond('東京都', ['東京都千代田区']);
    await tester.pump();
    search.respond('東京', ['東京タワー']);
    await tester.pump();

    expect(find.text('東京都千代田区'), findsOneWidget);
    expect(find.text('東京タワー'), findsNothing);
  });

  testWidgets('取得中に画面を離れても、例外にならない', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search);
    await _type(tester, '東京');
    await tester.pumpWidget(const SizedBox());

    search.respond('東京', ['東京都千代田区']);
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('入力を空にしたら、取得中の応答が届いても一覧を出さない', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search);
    await _type(tester, '東京');
    await tester.enterText(find.byKey(_fieldKey), '');
    await tester.pump();

    search.respond('東京', ['東京都千代田区']);
    await tester.pump();
    expect(find.text('東京都千代田区'), findsNothing);
  });

  testWidgets('長い入力は、先頭から上限の長さまでで検索する', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search, maxQueryLength: 5);
    await _type(tester, '東京都千代田区丸の内1丁目');
    expect(search.queries, ['東京都千代']);

    // 上限より後ろだけを書き換えても、同じ検索を繰り返さない
    await _type(tester, '東京都千代田区丸の内2丁目');
    expect(search.queries, ['東京都千代']);
  });

  testWidgets('日本語入力の変換中は取得せず、確定してから取得する', (tester) async {
    final search = _FakeSearch();
    final (:controller, selected: _) = await _pump(tester, search);

    // 変換中（未確定の文字に下線が付いている状態）
    controller.value = const TextEditingValue(
      text: 'とうきょう',
      selection: TextSelection.collapsed(offset: 5),
      composing: TextRange(start: 0, end: 5),
    );
    await tester.pump(suggestionDebounce * 2);
    expect(search.queries, isEmpty);

    // 文字はそのままで確定する
    controller.value = const TextEditingValue(
      text: 'とうきょう',
      selection: TextSelection.collapsed(offset: 5),
    );
    await tester.pump(suggestionDebounce);
    expect(search.queries, ['とうきょう']);
  });

  testWidgets('カーソルを動かしただけでは、取得し直さない', (tester) async {
    final search = _FakeSearch();
    final (:controller, selected: _) = await _pump(tester, search);
    await _type(tester, '東京');
    controller.selection = const TextSelection.collapsed(offset: 1);
    await tester.pump(suggestionDebounce);
    expect(search.queries, ['東京']);
  });

  testWidgets('候補を選ぶと一覧が閉じ、選んだ内容を入力欄に入れても取得し直さない', (tester) async {
    final search = _FakeSearch();
    final (:controller, :selected) = await _pump(tester, search);
    await _type(tester, '東京');
    search.respond('東京', ['東京都千代田区', '東京都港区']);
    await tester.pump();

    await tester.tap(find.text('東京都港区'));
    await tester.pump(suggestionDebounce * 2);
    expect(selected, ['東京都港区']);
    expect(controller.text, '東京都港区');
    expect(find.text('東京都千代田区'), findsNothing);
    expect(search.queries, ['東京']);
  });

  testWidgets('Esc で一覧を閉じる', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search);
    await _type(tester, '東京');
    search.respond('東京', ['東京都千代田区']);
    await tester.pump();
    expect(find.text('東京都千代田区'), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.text('東京都千代田区'), findsNothing);
  });

  testWidgets('候補の行にフォーカスがあっても Esc で閉じ、入力欄に戻っても開き直さない', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search, searchOnFocus: true);
    await _type(tester, '東京');
    search.respond('東京', ['東京都千代田区']);
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(_fieldHasFocus(tester), isFalse);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump(suggestionDebounce);
    expect(find.text('東京都千代田区'), findsNothing);
    expect(_fieldHasFocus(tester), isTrue);
    expect(search.queries, ['東京']);
  });

  testWidgets('↓ と Enter で候補を選んだあと、searchOnFocus でも一覧を開き直さない', (tester) async {
    final search = _FakeSearch();
    final (controller: _, :selected) = await _pump(
      tester,
      search,
      searchOnFocus: true,
    );
    await _type(tester, '東京');
    search.respond('東京', ['東京都千代田区']);
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump(suggestionDebounce);
    expect(selected, ['東京都千代田区']);
    expect(_fieldHasFocus(tester), isTrue);
    expect(search.queries, ['東京']);
  });

  testWidgets('取得を待つ間に変換を始めて取り消しても、元の文字で取得する', (tester) async {
    final search = _FakeSearch();
    final (:controller, selected: _) = await _pump(tester, search);
    await tester.enterText(find.byKey(_fieldKey), '東京');
    await tester.pump(suggestionDebounce ~/ 2);

    // 取得が始まる前に、続きの変換を始める
    controller.value = const TextEditingValue(
      text: '東京と',
      selection: TextSelection.collapsed(offset: 3),
      composing: TextRange(start: 2, end: 3),
    );
    await tester.pump(suggestionDebounce * 2);
    expect(search.queries, isEmpty);

    // 変換を取り消して、元の文字に戻る
    controller.value = const TextEditingValue(
      text: '東京',
      selection: TextSelection.collapsed(offset: 2),
    );
    await tester.pump(suggestionDebounce);
    expect(search.queries, ['東京']);
  });

  testWidgets('取得中に入力を変えたら、前の入力の応答が先に届いても候補を出さない', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search);
    await _type(tester, '東京');
    await tester.enterText(find.byKey(_fieldKey), '大阪');
    await tester.pump();

    // 「大阪」の取得が始まる前に、「東京」の応答が届く
    search.respond('東京', ['東京都千代田区']);
    await tester.pump();
    expect(find.text('東京都千代田区'), findsNothing);
    expect(search.queries, ['東京']);

    await tester.pump(suggestionDebounce);
    search.respond('大阪', ['大阪府大阪市']);
    await tester.pump();
    expect(find.text('大阪府大阪市'), findsOneWidget);
  });

  testWidgets('候補が出ているときに入力を変えたら、前の候補をすぐに消す', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search);
    await _type(tester, '東京');
    search.respond('東京', ['東京都千代田区']);
    await tester.pump();
    expect(find.text('東京都千代田区'), findsOneWidget);

    await tester.enterText(find.byKey(_fieldKey), '大阪');
    await tester.pump();
    expect(find.text('東京都千代田区'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.pump(suggestionDebounce);
    expect(search.queries, ['東京', '大阪']);
  });

  testWidgets('↓ で最初の候補へ移り、Enter で選べる', (tester) async {
    final search = _FakeSearch();
    final (controller: _, :selected) = await _pump(tester, search);
    await _type(tester, '東京');
    search.respond('東京', ['東京都千代田区', '東京都港区']);
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(selected, ['東京都千代田区']);
  });

  testWidgets('searchOnFocus なら、文字の入った入力欄に移っただけで候補を出す', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search, initialText: '東京都千代田区', searchOnFocus: true);
    expect(search.queries, isEmpty);

    await tester.tap(find.byKey(_fieldKey));
    await tester.pump();
    expect(search.queries, ['東京都千代田区']);
  });

  testWidgets('searchOnFocus でなければ、入力欄に移っただけでは取得しない', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search, initialText: '東京都千代田区');
    await tester.tap(find.byKey(_fieldKey));
    await tester.pump(suggestionDebounce);
    expect(search.queries, isEmpty);
  });

  testWidgets('失敗したら再試行でき、同じ検索文字で取得し直す', (tester) async {
    final search = _FakeSearch();
    await _pump(tester, search);
    await _type(tester, '東京');
    search.fail('東京');
    await tester.pump();
    expect(find.text(LoadErrorView.defaultMessage), findsOneWidget);

    await tester.tap(find.text(LoadErrorView.retryLabel));
    await tester.pump();
    search.respond('東京', ['東京都千代田区']);
    await tester.pump();
    expect(search.queries, ['東京', '東京']);
    expect(find.text('東京都千代田区'), findsOneWidget);
  });

  testWidgets('候補の一覧が開いていても、入力欄そのものに読み上げ用の名前が付く', (tester) async {
    final handle = tester.ensureSemantics();
    final search = _FakeSearch();
    await _pump(tester, search);
    await _type(tester, '東京');
    search.respond('東京', ['東京都千代田区']);
    await tester.pump();

    final field = tester.getSemantics(find.bySemanticsLabel('自宅住所（必須）'));
    expect(field.flagsCollection.isTextField, isTrue);
    expect(field.value, '東京');
    handle.dispose();
  });
}
