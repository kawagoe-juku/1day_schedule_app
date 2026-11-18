import 'package:ai_schedule_app/api/generated/api.dart';
import 'package:ai_schedule_app/profile/profile_providers.dart';
import 'package:ai_schedule_app/screens/home_screen.dart';
import 'package:ai_schedule_app/screens/legal_dialog.dart';
import 'package:ai_schedule_app/screens/login_screen.dart';
import 'package:ai_schedule_app/screens/onboarding_screen.dart';
import 'package:ai_schedule_app/widgets/load_error_view.dart';
import 'package:ai_schedule_app/widgets/suggestion_field.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers.dart';

const _address = '日本、東京都千代田区丸の内1丁目';
const _placeId = 'place-marunouchi';

const _addressPath = '/api/geo/address-suggestions';
const _stationPath = '/api/geo/station-suggestions';

Map<String, Object?> _station(String code, String name) => {
  'stationCode': code,
  'stationName': name,
  'prefecture': '東京都',
};

/// 初回設定が済んでいない利用者がログイン済みの状態で起動する（＝初回設定が開く）。
Future<TestEnvironment> _pumpOnboarding(
  WidgetTester tester, {
  TestEnvironment? env,
}) => pumpApp(
  tester,
  env: (env ?? (TestEnvironment()..addUser(signedIn: true)))
    ..onboardingCompleted = false
    ..addressSuggestions = [
      {'placeId': _placeId, 'description': _address},
      {'placeId': 'place-2', 'description': '日本、東京都千代田区丸の内2丁目'},
    ]
    ..stationSuggestions = [
      _station('00004254', '新宿'),
      _station('00004255', '新宿三丁目'),
    ],
);

/// 入力欄に文字を入れ、候補の取得が終わるまで待つ。
Future<void> _type(WidgetTester tester, String key, String text) async {
  await enter(tester, key, text);
  await tester.pump(suggestionDebounce);
  await tester.pumpAndSettle();
}

/// 候補の一覧から [label] の行を選ぶ（入力欄の文字と区別するため、行そのものを探す）。
Future<void> _pick(WidgetTester tester, String label) async {
  // 登録済みの駅のチップにも同じ名前が出るので、先に並ぶ候補の行を選ぶ
  await tester.tap(find.widgetWithText(InkWell, label).first);
  await tester.pumpAndSettle();
}

Future<void> _next(WidgetTester tester) => tapKey(tester, 'onboarding-next');
Future<void> _back(WidgetTester tester) => tapKey(tester, 'onboarding-back');

/// Step1 で住所を入力し、候補を選ぶ。
Future<void> _chooseHome(WidgetTester tester) async {
  await _type(tester, 'onboarding-home-address', '東京都千代田区丸の内');
  await _pick(tester, _address);
}

/// Step1 から [step]（1 始まり）まで、必須項目だけ入力して進める。
Future<void> _goToStep(WidgetTester tester, int step) async {
  await _chooseHome(tester);
  for (var current = 1; current < step; current++) {
    await _next(tester);
  }
  expect(find.text('進捗: $step/6'), findsOneWidget);
}

String _fieldText(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(Key(key))).controller!.text;

void main() {
  group('共通', () {
    testWidgets('IT-027 進捗バーが 1/6 から 6/6 まで進む', (tester) async {
      await _pumpOnboarding(tester);
      expectScreen(OnboardingScreen.title);
      expect(find.text('進捗: 1/6'), findsOneWidget);
      expect(find.text('Step 1: 自宅'), findsOneWidget);

      await _chooseHome(tester);
      const titles = [
        'Step 2: よく使う駅（任意）',
        'Step 3: 徒歩速度・準備時間',
        'Step 4: 優先条件',
        'Step 5: カレンダー連携（任意）',
        'Step 6: 利用同意',
      ];
      for (final (index, title) in titles.indexed) {
        await _next(tester);
        expect(find.text('進捗: ${index + 2}/6'), findsOneWidget);
        expect(find.text(title), findsOneWidget);
      }
      // 最後のステップでは、ボタンが「完了」になる
      expect(find.widgetWithText(FilledButton, '完了'), findsOneWidget);
    });

    testWidgets('Step1 では「戻る」を押せない', (tester) async {
      await _pumpOnboarding(tester);
      final back = tester.widget<OutlinedButton>(
        find.byKey(const Key('onboarding-back')),
      );
      expect(back.onPressed, isNull);
    });

    testWidgets('IT-045 戻っても、入力した値が残っている', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 2);
      await _type(tester, 'onboarding-station', '新宿');
      await _pick(tester, '新宿');
      await _next(tester);
      await enter(tester, 'onboarding-preparation-time', '45');

      await _back(tester);
      expect(find.widgetWithText(InputChip, '新宿'), findsOneWidget);
      await _back(tester);
      expect(_fieldText(tester, 'onboarding-home-address'), _address);

      // 選んだ候補も覚えているので、選び直さずに先へ進める
      await _next(tester);
      await _next(tester);
      expect(_fieldText(tester, 'onboarding-preparation-time'), '45');
    });

    testWidgets('IT-046 途中でやめると何も保存されず、次に開いたときは Step1 からになる', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 3);
      expect(env.requestsTo('/api/profile', method: 'PUT'), isEmpty);

      // アプリを開き直す
      await tester.pumpWidget(const SizedBox());
      await _pumpOnboarding(tester, env: env);
      expectScreen(OnboardingScreen.title);
      expect(find.text('進捗: 1/6'), findsOneWidget);
      expect(_fieldText(tester, 'onboarding-home-address'), isEmpty);
    });

    testWidgets('ステップが変わると、見出しにフォーカスが移る', (tester) async {
      await _pumpOnboarding(tester);
      await _chooseHome(tester);
      await _next(tester);
      expect(
        FocusManager.instance.primaryFocus?.debugLabel,
        'onboarding-heading',
      );
      await _back(tester);
      expect(
        FocusManager.instance.primaryFocus?.debugLabel,
        'onboarding-heading',
      );
    });

    for (final width in [320.0, 1400.0]) {
      testWidgets('幅 $width でも全ステップが崩れず、ボタンは本文と同じ幅に収まる', (tester) async {
        await pumpApp(
          tester,
          width: width,
          env: TestEnvironment()
            ..addUser(signedIn: true)
            ..onboardingCompleted = false
            ..addressSuggestions = [
              {'placeId': _placeId, 'description': _address},
            ],
        );
        await _chooseHome(tester);
        for (var step = 1; step < 6; step++) {
          await _next(tester);
          expect(tester.takeException(), isNull);
        }
        final next = tester.getRect(find.byKey(const Key('onboarding-next')));
        final back = tester.getRect(find.byKey(const Key('onboarding-back')));
        expect(next.right - back.left, lessThanOrEqualTo(560));
      });
    }

    testWidgets('途中でログアウトできる', (tester) async {
      await _pumpOnboarding(tester);
      await tapKey(tester, 'onboarding-logout');
      expectScreen(LoginScreen.title);
    });

    testWidgets('プロファイルを取得できなければ「取得に失敗しました」を出し、再試行できる', (tester) async {
      final env = TestEnvironment()..addUser(signedIn: true);
      await _pumpOnboarding(tester, env: env);
      // 画面を開いたあとの取り直しだけ失敗させる
      env.profileFailureStatus = 500;
      containerOf(tester).invalidate(profileProvider);
      await tester.pumpAndSettle();
      expect(find.text(LoadErrorView.defaultMessage), findsOneWidget);

      env.profileFailureStatus = null;
      await tapButton(tester, LoadErrorView.retryLabel);
      expect(find.text('進捗: 1/6'), findsOneWidget);
    });
  });

  group('Step1 自宅', () {
    testWidgets('IT-028 入力すると住所の候補の API を呼び、候補を出す', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _type(tester, 'onboarding-home-address', '東京都千代田区丸の内');

      final requests = env.requestsTo(_addressPath);
      expect(requests, hasLength(1));
      expect(requests.single.uri.queryParameters['q'], '東京都千代田区丸の内');
      expect(requests.single.headers['Authorization'], isNotNull);
      expect(find.text(_address), findsOneWidget);
      expect(find.text('日本、東京都千代田区丸の内2丁目'), findsOneWidget);
    });

    testWidgets('入力の途中では API を呼ばず、止まってから1回だけ呼ぶ', (tester) async {
      final env = await _pumpOnboarding(tester);
      await enter(tester, 'onboarding-home-address', '東京');
      await tester.pump(const Duration(milliseconds: 100));
      await enter(tester, 'onboarding-home-address', '東京都');
      await tester.pump(const Duration(milliseconds: 100));
      expect(env.requestsTo(_addressPath), isEmpty);

      await tester.pump(suggestionDebounce);
      await tester.pumpAndSettle();
      expect(env.requestsTo(_addressPath), hasLength(1));
      expect(
        env.requestsTo(_addressPath).single.uri.queryParameters['q'],
        '東京都',
      );
    });

    testWidgets('候補を選ぶと入力欄に入り、一覧が閉じて、次へ進める', (tester) async {
      await _pumpOnboarding(tester);
      await _chooseHome(tester);
      expect(_fieldText(tester, 'onboarding-home-address'), _address);
      expect(find.text('日本、東京都千代田区丸の内2丁目'), findsNothing);

      await _next(tester);
      expect(find.text('進捗: 2/6'), findsOneWidget);
    });

    testWidgets('IT-030 空のままでは、エラーを出して先へ進めない', (tester) async {
      await _pumpOnboarding(tester);
      await _next(tester);
      expect(find.text('自宅住所を入力してください'), findsOneWidget);
      expect(find.text('進捗: 1/6'), findsOneWidget);
    });

    testWidgets('入力しただけで候補を選んでいなければ、先へ進めない', (tester) async {
      await _pumpOnboarding(tester);
      await _type(tester, 'onboarding-home-address', '東京都千代田区丸の内');
      await _next(tester);
      expect(find.text('自宅住所は候補から選んでください'), findsOneWidget);
      expect(find.text('進捗: 1/6'), findsOneWidget);
    });

    testWidgets('候補を選んだあとに書き換えたら、選び直すまで進めない', (tester) async {
      await _pumpOnboarding(tester);
      await _chooseHome(tester);
      await _type(tester, 'onboarding-home-address', '$_address 9-9');
      await _next(tester);
      expect(find.text('自宅住所は候補から選んでください'), findsOneWidget);
    });

    testWidgets('住所の欄で Enter を押すと「次へ」と同じ動きをする', (tester) async {
      await _pumpOnboarding(tester);
      await _type(tester, 'onboarding-home-address', '東京都千代田区丸の内');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      // 候補を選んでいないので進めない
      expect(find.text('自宅住所は候補から選んでください'), findsOneWidget);

      await _pick(tester, _address);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(find.text('進捗: 2/6'), findsOneWidget);
    });

    testWidgets('100文字を超える住所でも、先頭100文字で候補を取得する（サーバの上限）', (tester) async {
      final env = await _pumpOnboarding(tester);
      final long = '東京都千代田区丸の内1丁目${'あ' * 120}';
      await _type(tester, 'onboarding-home-address', long);

      final q = env.requestsTo(_addressPath).single.uri.queryParameters['q']!;
      expect(q, hasLength(100));
      expect(long.startsWith(q), isTrue);
      expect(find.widgetWithText(InkWell, _address), findsOneWidget);
    });

    testWidgets('候補の一覧が開いていても、入力欄に読み上げ用の名前が付く', (tester) async {
      final handle = tester.ensureSemantics();
      await _pumpOnboarding(tester);
      await _type(tester, 'onboarding-home-address', '東京');
      final field = tester.getSemantics(find.bySemanticsLabel('自宅住所（必須）'));
      expect(field.flagsCollection.isTextField, isTrue);
      handle.dispose();
    });

    testWidgets('IT-031 候補が0件なら「候補がありません」と出し、エラーにしない', (tester) async {
      final env = await _pumpOnboarding(tester);
      env.addressSuggestions = [];
      await _type(tester, 'onboarding-home-address', 'あいうえおかきくけこ');
      expect(find.text(SuggestionField.emptyMessage), findsOneWidget);
      expect(find.text(LoadErrorView.defaultMessage), findsNothing);
    });

    testWidgets('IT-032 候補の取得に失敗したら、その場に「取得に失敗しました」と再試行を出す', (tester) async {
      final env = await _pumpOnboarding(tester);
      env.suggestionsUnavailable = true;
      await _type(tester, 'onboarding-home-address', '東京都千代田区丸の内');
      expect(find.text(LoadErrorView.defaultMessage), findsOneWidget);
      // 画面のほかの部分はそのまま使える
      expect(find.text('Step 1: 自宅'), findsOneWidget);

      env.suggestionsUnavailable = false;
      await tapButton(tester, LoadErrorView.retryLabel);
      expect(find.text(LoadErrorView.defaultMessage), findsNothing);
      expect(find.text(_address), findsOneWidget);
    });
  });

  group('Step2 よく使う駅', () {
    testWidgets('IT-033 入力すると駅名の候補の API を呼び、選ぶと登録される', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 2);
      await _type(tester, 'onboarding-station', '新宿');

      expect(
        env.requestsTo(_stationPath).single.uri.queryParameters['q'],
        '新宿',
      );
      expect(find.text('新宿三丁目'), findsOneWidget);

      await _pick(tester, '新宿三丁目');
      expect(find.widgetWithText(InputChip, '新宿三丁目'), findsOneWidget);
      // 続けて入力できるように、入力欄は空に戻る
      expect(_fieldText(tester, 'onboarding-station'), isEmpty);
      expect(find.textContaining('1/20件'), findsOneWidget);
    });

    testWidgets('登録した駅は削除できる', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 2);
      await _type(tester, 'onboarding-station', '新宿');
      await _pick(tester, '新宿');

      await tester.tap(find.byTooltip('新宿を削除'));
      await tester.pumpAndSettle();
      expect(find.byType(InputChip), findsNothing);
      expect(find.textContaining('0/20件'), findsOneWidget);
    });

    testWidgets('同じ駅は2回登録できない', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 2);
      for (var i = 0; i < 2; i++) {
        await _type(tester, 'onboarding-station', '新宿');
        await _pick(tester, '新宿');
      }
      expect(find.text('「新宿」は登録済みです'), findsOneWidget);
      expect(find.byType(InputChip), findsOneWidget);
    });

    testWidgets('IT-034 20件まで登録でき、21件目は追加できない旨を出す', (tester) async {
      final env = TestEnvironment()
        ..addUser(signedIn: true)
        ..frequentStations = [
          for (var i = 0; i < 19; i++)
            {'stationCode': 'code-$i', 'stationName': '駅$i'},
        ];
      await _pumpOnboarding(tester, env: env);
      await _goToStep(tester, 2);
      expect(find.textContaining('19/20件'), findsOneWidget);

      // 20件目は登録できる
      await _type(tester, 'onboarding-station', '新宿');
      await _pick(tester, '新宿');
      expect(find.textContaining('20/20件'), findsOneWidget);

      // 21件目は登録できない
      await _type(tester, 'onboarding-station', '新宿');
      await _pick(tester, '新宿三丁目');
      expect(find.textContaining('20件まで登録できます'), findsOneWidget);
      expect(find.byType(InputChip), findsNWidgets(20));
    });

    testWidgets('駅名の候補が0件なら「候補がありません」と出す', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 2);
      env.stationSuggestions = [];
      await _type(tester, 'onboarding-station', 'あいうえお');
      expect(find.text(SuggestionField.emptyMessage), findsOneWidget);
    });

    testWidgets('駅名の候補の取得に失敗したら再試行でき、登録しないまま先へも進める', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 2);
      env.suggestionsUnavailable = true;
      await _type(tester, 'onboarding-station', '新宿');
      expect(find.text(LoadErrorView.defaultMessage), findsOneWidget);

      env.suggestionsUnavailable = false;
      await tapButton(tester, LoadErrorView.retryLabel);
      expect(find.widgetWithText(InkWell, '新宿三丁目'), findsOneWidget);

      await _next(tester);
      expect(find.text('進捗: 3/6'), findsOneWidget);
    });

    testWidgets('IT-035 駅を登録しなくても先へ進める', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 2);
      await _next(tester);
      expect(find.text('進捗: 3/6'), findsOneWidget);
    });
  });

  group('Step3 徒歩速度・準備時間', () {
    testWidgets('IT-036 徒歩速度と準備時間に初期値が入っている', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 3);
      expect(find.text('標準'), findsOneWidget);
      expect(_fieldText(tester, 'onboarding-preparation-time'), '30');
    });

    for (final (input, message) in [
      ('abc', '準備時間は半角数字で入力してください'),
      ('-5', '準備時間は半角数字で入力してください'),
      ('', '準備時間を入力してください'),
      ('１０', '準備時間は半角数字で入力してください'),
      ('181', '準備時間は0〜180分で入力してください'),
    ]) {
      testWidgets('IT-037 準備時間が「$input」なら、エラーを出して先へ進めない', (tester) async {
        await _pumpOnboarding(tester);
        await _goToStep(tester, 3);
        await enter(tester, 'onboarding-preparation-time', input);
        await _next(tester);
        expect(find.text(message), findsOneWidget);
        expect(find.text('進捗: 3/6'), findsOneWidget);
      });
    }

    testWidgets('準備時間の欄で Enter を押すと、次へ進む', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 3);
      await enter(tester, 'onboarding-preparation-time', '20');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(find.text('進捗: 4/6'), findsOneWidget);
    });

    test('準備時間は 0〜180 の半角数字だけを受け付ける', () {
      expect(validatePreparationTime('0'), isNull);
      expect(validatePreparationTime('180'), isNull);
      expect(validatePreparationTime(' 45 '), isNull);
      expect(validatePreparationTime('1.5'), isNotNull);
      expect(validatePreparationTime('99999999999999999999'), isNotNull);
    });
  });

  group('Step4 優先条件', () {
    testWidgets('IT-038 初期値は「遅刻厳禁」で、3つから1つを選べる', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 4);
      RadioGroup<PriorityCondition> group() =>
          tester.widget(find.byType(RadioGroup<PriorityCondition>));
      expect(group().groupValue, PriorityCondition.onTime);
      for (final label in ['遅刻厳禁', '節約重視', 'ポイント優先']) {
        expect(find.text(label), findsOneWidget);
      }

      await tester.tap(find.text('節約重視'));
      await tester.pumpAndSettle();
      expect(group().groupValue, PriorityCondition.saveMoney);
    });
  });

  group('Step5 カレンダー連携', () {
    testWidgets('Google・Outlook のボタンがあり、連携しなくても先へ進める', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 5);
      expect(find.text('Google カレンダー連携'), findsOneWidget);
      expect(find.text('Outlook カレンダー連携'), findsOneWidget);

      await _next(tester);
      expect(find.text('進捗: 6/6'), findsOneWidget);
    });
  });

  group('Step6 利用同意', () {
    testWidgets('IT-042 同意にチェックがなければ、エラーを出して完了できない', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 6);
      await _next(tester);
      expect(find.text('利用への同意が必要です'), findsOneWidget);
      expectScreen(OnboardingScreen.title);
      expect(env.requestsTo('/api/profile', method: 'PUT'), isEmpty);
    });

    testWidgets('IT-043 同意事項と、利用規約・プライバシーポリシーへのリンクを出す', (tester) async {
      await _pumpOnboarding(tester);
      await _goToStep(tester, 6);
      for (final item in consentItems) {
        expect(find.text(item), findsOneWidget);
      }
      // Web 版では位置情報を取得しないことを、はっきり書く
      expect(find.text('Web版では、端末の位置情報を取得しません。'), findsOneWidget);

      for (final document in LegalDocument.values) {
        await tapKey(tester, 'onboarding-legal-${document.name}');
        expect(
          find.widgetWithText(AlertDialog, document.title),
          findsOneWidget,
        );
        await tester.tap(find.text('閉じる'));
        await tester.pumpAndSettle();
      }
      // 開いて閉じても、初回設定の入力は続けられる
      expect(find.text('進捗: 6/6'), findsOneWidget);
    });
  });

  group('完了', () {
    testWidgets('IT-029・038・044 入力した内容をすべて保存し、ホームへ進む', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 2);
      await _type(tester, 'onboarding-station', '新宿');
      await _pick(tester, '新宿');
      await _next(tester);

      await tester.tap(find.byKey(const Key('onboarding-walking-speed')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('速い').last);
      await tester.pumpAndSettle();
      await enter(tester, 'onboarding-preparation-time', '45');
      await _next(tester);

      await tester.tap(find.text('節約重視'));
      await tester.pumpAndSettle();
      await _next(tester);
      await _next(tester);

      await tapKey(tester, 'onboarding-consent');
      await _next(tester);

      expect(env.requestsTo('/api/profile', method: 'PUT'), hasLength(1));
      expect(env.savedProfile, {
        'homeAddress': _address,
        'homePlaceId': _placeId,
        'frequentStations': [
          {'stationCode': '00004254', 'stationName': '新宿'},
        ],
        'walkingSpeed': 'fast',
        'preparationTimeMinutes': 45,
        'priorityCondition': 'save_money',
        'acceptTerms': true,
        'completeOnboarding': true,
      });
      expectScreen(HomeScreen.title);
    });

    testWidgets('初期値のままでも完了できる（駅なし・標準・30分・遅刻厳禁）', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 6);
      await tapKey(tester, 'onboarding-consent');
      await _next(tester);

      expect(env.savedProfile, {
        'homeAddress': _address,
        'homePlaceId': _placeId,
        'frequentStations': <Object?>[],
        'walkingSpeed': 'normal',
        'preparationTimeMinutes': 30,
        'priorityCondition': 'on_time',
        'acceptTerms': true,
        'completeOnboarding': true,
      });
      expectScreen(HomeScreen.title);
    });

    testWidgets('サーバが住所を確認できなければ、Step1 に戻してエラーを出し、選び直せる', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 6);
      await tapKey(tester, 'onboarding-consent');
      env.profileSaveFailure = (
        400,
        {
          'error': {
            'code': 'VALIDATION_ERROR',
            'message': '入力内容を確認してください',
            'requestId': 'req-9',
            'details': [
              {
                'field': 'homePlaceId',
                'message': '住所を確認できませんでした。候補から選び直してください',
              },
            ],
          },
        },
      );
      await _next(tester);

      expect(find.text('進捗: 1/6'), findsOneWidget);
      expect(find.text('住所を確認できませんでした。候補から選び直してください'), findsOneWidget);

      // 選び直すまでは進めない
      await _next(tester);
      expect(find.text('進捗: 1/6'), findsOneWidget);

      // 入力し直さなくても、候補の一覧が開いていて選び直せる
      env.profileSaveFailure = null;
      expect(_fieldText(tester, 'onboarding-home-address'), _address);
      await _pick(tester, _address);
      for (var step = 1; step < 6; step++) {
        await _next(tester);
      }
      // 同意のチェックは残っている
      await _next(tester);
      expectScreen(HomeScreen.title);
      expect(env.savedProfile?['homePlaceId'], _placeId);
    });

    testWidgets('「完了」を続けて押しても、保存は1回だけ。完了後にプロファイルを取り直さない', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 6);
      await tapKey(tester, 'onboarding-consent');
      final getsBefore = env.requestsTo('/api/profile').length;

      final next = find.byKey(const Key('onboarding-next'));
      await tester.tap(next);
      await tester.tap(next);
      await tester.pumpAndSettle();

      expect(env.requestsTo('/api/profile', method: 'PUT'), hasLength(1));
      expect(env.requestsTo('/api/profile'), hasLength(getsBefore));
      expectScreen(HomeScreen.title);
    });

    testWidgets('保存時にログインが切れていたら（401）、ログイン画面へ戻る', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 6);
      await tapKey(tester, 'onboarding-consent');
      env.profileSaveFailure = (
        401,
        {
          'error': {
            'code': 'UNAUTHORIZED',
            'message': '認証が必要です',
            'requestId': 'req-9',
          },
        },
      );
      await _next(tester);
      expect(tester.takeException(), isNull);
      expectScreen(LoginScreen.title);
    });

    for (final (field, step, message) in [
      ('frequentStations.0.stationName', 2, '駅名を確認してください'),
      ('preparationTimeMinutes', 3, '準備時間を確認してください'),
      ('acceptTerms', 6, '利用への同意が必要です'),
    ]) {
      testWidgets('サーバが $field のエラーを返したら、Step$step のその項目に出す', (tester) async {
        final env = await _pumpOnboarding(tester);
        await _goToStep(tester, 6);
        await tapKey(tester, 'onboarding-consent');
        env.profileSaveFailure = (
          400,
          {
            'error': {
              'code': 'VALIDATION_ERROR',
              'message': '入力内容を確認してください',
              'requestId': 'req-9',
              'details': [
                {'field': field, 'message': message},
              ],
            },
          },
        );
        await _next(tester);

        expect(find.text('進捗: $step/6'), findsOneWidget);
        expect(find.text(message), findsOneWidget);
        // 項目に出したので、ボタンの上の共通メッセージは出さない
        expect(find.text('入力内容を確認してください'), findsNothing);
      });
    }

    testWidgets('保存に失敗したら、メッセージを出して Step6 に留まり、やり直せる', (tester) async {
      final env = await _pumpOnboarding(tester);
      await _goToStep(tester, 6);
      await tapKey(tester, 'onboarding-consent');
      env.profileSaveFailure = (
        502,
        {
          'error': {
            'code': 'EXTERNAL_SERVICE_ERROR',
            'message': '外部サービスの呼び出しに失敗しました',
            'requestId': 'req-9',
          },
        },
      );
      await _next(tester);

      expectScreen(OnboardingScreen.title);
      expect(find.text('進捗: 6/6'), findsOneWidget);
      expect(find.text('外部サービスの呼び出しに失敗しました'), findsOneWidget);

      env.profileSaveFailure = null;
      await _next(tester);
      expectScreen(HomeScreen.title);
    });
  });
}
