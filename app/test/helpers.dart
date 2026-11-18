import 'dart:convert';

import 'package:ai_schedule_app/api/api_client.dart';
import 'package:ai_schedule_app/app.dart';
import 'package:ai_schedule_app/auth/session_controller.dart';
import 'package:ai_schedule_app/config/app_config.dart';
import 'package:ai_schedule_app/routing/app_router.dart';
import 'package:ai_schedule_app/widgets/app_frame.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'api/fake_http_adapter.dart';
import 'auth/fake_auth_service.dart';

const testEmail = 'user@example.com';
const testPassword = 'Password1';

/// テスト中のアプリの外側（認証・サーバ・時刻）の代用品。
class TestEnvironment {
  final auth = FakeAuthService();
  final activity = MemoryActivityStore();

  /// 現在時刻（テストの中で進められる）
  DateTime now = DateTime(2026, 11, 11, 12);

  /// サーバが返すプロファイルの「初回設定が済んでいるか」
  bool onboardingCompleted = true;

  /// true の間、`GET /api/config` を失敗させる
  bool configUnavailable = false;

  /// `/api/profile`（取得・保存とも）を、このステータスの失敗にする（401：トークンの失効、500：サーバの障害）
  int? profileFailureStatus;

  /// サーバにあるプロファイルの、よく使う駅
  List<Map<String, Object?>> frequentStations = [];

  /// `GET /api/geo/address-suggestions` が返す候補
  List<Map<String, Object?>> addressSuggestions = [];

  /// `GET /api/geo/station-suggestions` が返す候補
  List<Map<String, Object?>> stationSuggestions = [];

  /// true の間、候補の API（住所・駅名）を 502 にする
  bool suggestionsUnavailable = false;

  /// `PUT /api/profile` を、この応答（ステータスと本文）の失敗にする
  (int, Map<String, Object?>)? profileSaveFailure;

  /// `PUT /api/profile` で最後に保存された内容（保存されていなければ null）
  Map<String, Object?>? savedProfile;

  late final FakeHttpAdapter server = FakeHttpAdapter(_respond);

  /// [path] への呼び出し（呼ばれた順）。
  List<RequestOptions> requestsTo(String path, {String method = 'GET'}) => [
    for (final request in server.requests)
      if (request.uri.path == path && request.method == method) request,
  ];

  Map<String, Object?> _profile() => {
    'email': testEmail,
    'onboardingCompleted': onboardingCompleted,
    'homeAddress': savedProfile?['homeAddress'],
    'homeLocation': savedProfile == null
        ? null
        : {'lat': 35.681236, 'lng': 139.767125},
    'frequentStations': savedProfile?['frequentStations'] ?? frequentStations,
    'walkingSpeed': savedProfile?['walkingSpeed'] ?? 'normal',
    'preparationTimeMinutes': savedProfile?['preparationTimeMinutes'] ?? 30,
    'priorityCondition': savedProfile?['priorityCondition'] ?? 'on_time',
    'termsAcceptedAt': savedProfile?['acceptTerms'] == true
        ? '2026-11-11T12:00:00+09:00'
        : null,
  };

  ResponseBody _suggestions(List<Map<String, Object?>> items) =>
      suggestionsUnavailable
      ? FakeHttpAdapter.jsonResponse(502, {
          'error': {
            'code': 'EXTERNAL_SERVICE_ERROR',
            'message': '外部サービスの呼び出しに失敗しました',
            'requestId': 'req-3',
          },
        })
      : FakeHttpAdapter.jsonResponse(200, {'items': items});

  ResponseBody _respond(RequestOptions options) {
    switch (options.uri.path) {
      case '/api/config':
        if (configUnavailable) {
          throw DioException.connectionError(
            requestOptions: options,
            reason: 'テスト用の通信エラー',
          );
        }
        return FakeHttpAdapter.jsonResponse(200, {
          'cognito': {
            'region': 'ap-northeast-1',
            'userPoolId': 'ap-northeast-1_TestPool1',
            'webClientId': 'test-web-client',
          },
        });
      case '/api/profile':
        if (options.headers['Authorization'] == null) {
          return FakeHttpAdapter.jsonResponse(401, {
            'error': {
              'code': 'UNAUTHORIZED',
              'message': '認証が必要です',
              'requestId': 'req-1',
            },
          });
        }
        if (profileFailureStatus case final status?) {
          return FakeHttpAdapter.jsonResponse(status, {
            'error': {
              'code': status == 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
              'message': 'テスト用の失敗',
              'requestId': 'req-2',
            },
          });
        }
        if (options.method == 'PUT') {
          if (profileSaveFailure case (final status, final body)?) {
            return FakeHttpAdapter.jsonResponse(status, body);
          }
          final body = (jsonDecode(options.data as String) as Map)
              .cast<String, Object?>();
          savedProfile = body;
          if (body['completeOnboarding'] == true) onboardingCompleted = true;
        }
        return FakeHttpAdapter.jsonResponse(200, _profile());
      case '/api/geo/address-suggestions':
        return _suggestions(addressSuggestions);
      case '/api/geo/station-suggestions':
        return _suggestions(stationSuggestions);
    }
    return FakeHttpAdapter.jsonResponse(404, null);
  }

  /// 登録済み（確認済み）の利用者を1人用意する。
  void addUser({bool signedIn = false}) {
    auth.addUser(testEmail, testPassword);
    if (signedIn) auth.signedInEmail = testEmail;
  }
}

/// 画面幅を決めてアプリを起動する。[width] の既定はスマートフォン幅。
///
/// [env] を渡さなければ、初回設定まで済んだ利用者がログイン済みの状態で起動する。
Future<TestEnvironment> pumpApp(
  WidgetTester tester, {
  double width = 390,
  TestEnvironment? env,

  /// 起動時に開く場所（ブラウザでその URL を開いた・再読み込みした、という状況）
  String initialLocation = '/',
}) async {
  final environment = env ?? (TestEnvironment()..addUser(signedIn: true));
  tester.view.physicalSize = Size(width, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      retry: (retryCount, error) => null,
      overrides: [
        authServiceProvider.overrideWithValue(environment.auth),
        activityStoreProvider.overrideWithValue(environment.activity),
        clockProvider.overrideWithValue(() => environment.now),
        initialLocationProvider.overrideWithValue(initialLocation),
        apiDioProvider.overrideWith(
          (ref) => createApiDio(
            config: const AppConfig(env: AppEnv.local, apiBaseUrl: ''),
            getAccessToken: ref.watch(accessTokenGetterProvider),
            onUnauthorized: () => ref
                .read(sessionControllerProvider.notifier)
                .handleUnauthorized(),
            httpClientAdapter: environment.server,
          ),
        ),
      ],
      child: const App(),
    ),
  );
  await tester.pumpAndSettle();
  return environment;
}

/// 見出しに [title] が出ていること（＝その画面が開いていること）を確かめる。
void expectScreen(String title) {
  expect(
    find.descendant(
      of: find.bySemanticsLabel(title),
      matching: find.text(title),
    ),
    findsOneWidget,
    reason: '「$title」画面が開いていない',
  );
}

/// [label] のボタンを押して、画面が切り替わるのを待つ。
Future<void> tapButton(WidgetTester tester, String label) async {
  await tester.tap(find.widgetWithText(OutlinedButton, label));
  await tester.pumpAndSettle();
}

/// キーで指定した入力欄に文字を入れる。
Future<void> enter(WidgetTester tester, String key, String text) =>
    tester.enterText(find.byKey(Key(key)), text);

/// キーで指定したボタンを押して、処理が終わるのを待つ。
Future<void> tapKey(WidgetTester tester, String key) async {
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
}

/// 起動中のアプリの中身（状態・API クライアントなど）を取り出す。
ProviderContainer containerOf(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(AppFrame)));

/// いま開いている場所（ブラウザのアドレス欄にあたる）。
String currentLocation(WidgetTester tester) =>
    containerOf(tester)
        .read(routerProvider)
        .routerDelegate
        .currentConfiguration
        .uri
        .toString();
