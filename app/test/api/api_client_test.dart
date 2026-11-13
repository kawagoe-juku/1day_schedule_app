import 'package:ai_schedule_app/api/api_client.dart';
import 'package:ai_schedule_app/api/api_exception.dart';
import 'package:ai_schedule_app/api/generated/api.dart';
import 'package:ai_schedule_app/config/app_config.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_http_adapter.dart';

const _config = AppConfig(env: AppEnv.dev, apiBaseUrl: 'https://app.example');

Api _api(FakeHttpAdapter adapter, {String? token = 'test-token'}) => Api(
  createApiDio(
    config: _config,
    getAccessToken: () async => token,
    httpClientAdapter: adapter,
  ),
);

Map<String, Object?> _errorBody(
  String code, {
  String message = 'メッセージ',
  List<Map<String, String>>? details,
}) => {
  'error': {
    'code': code,
    'message': message,
    'requestId': 'req-1',
    'details': details,
  },
};

/// API を呼んで、失敗を [ApiException] として受け取る。
Future<ApiException> _failure(Future<Object?> Function() call) async {
  try {
    await call();
  } on Object catch (error) {
    return ApiException.from(error);
  }
  fail('失敗するはずの呼び出しが成功した');
}

void main() {
  group('JWT の自動付与', () {
    test('認証が必要な API には Authorization ヘッダーを付ける', () async {
      final adapter = FakeHttpAdapter.json(200, {
        'userId': 'user-1',
        'expiresAt': '2026-11-11T13:00:00+09:00',
      });

      final session = await _api(adapter).account.getSession();

      expect(session.userId, 'user-1');
      expect(session.expiresAt, DateTime.utc(2026, 11, 11, 4));
      final request = adapter.requests.single;
      expect(request.uri.toString(), 'https://app.example/api/session');
      expect(request.headers['Authorization'], 'Bearer test-token');
    });

    test('認証が不要な API（ヘルスチェック）には付けない', () async {
      final adapter = FakeHttpAdapter.json(200, {
        'status': 'ok',
        'version': '0.1.0',
      });

      await _api(adapter).health.getHealth();

      expect(adapter.requests.single.headers, isNot(contains('Authorization')));
    });

    test('未ログイン（トークンなし）のときは付けずに送る', () async {
      final adapter = FakeHttpAdapter.json(401, _errorBody('UNAUTHORIZED'));

      final error = await _failure(
        () => _api(adapter, token: null).account.getSession(),
      );

      expect(adapter.requests.single.headers, isNot(contains('Authorization')));
      expect(error.kind, ApiErrorKind.unauthorized);
    });
  });

  test('応答の null の項目は、省略された項目として読める', () async {
    final adapter = FakeHttpAdapter.json(200, {
      'email': 'user@example.com',
      'onboardingCompleted': false,
      'homeAddress': null,
      'homeLocation': null,
      'frequentStations': <Object?>[],
      'walkingSpeed': 'normal',
      'preparationTimeMinutes': 30,
      'priorityCondition': 'on_time',
      'termsAcceptedAt': null,
    });

    final profile = await _api(adapter).profile.getProfile();

    expect(profile.homeAddress, isNull);
    expect(profile.homeLocation, isNull);
    expect(profile.termsAcceptedAt, isNull);
    expect(profile.walkingSpeed, WalkingSpeed.normal);
  });

  group('失敗の変換', () {
    test('入力エラー（400）は項目ごとの内容を取り出す', () async {
      final adapter = FakeHttpAdapter.json(
        400,
        _errorBody(
          'VALIDATION_ERROR',
          message: '入力内容を確認してください',
          details: [
            {'field': 'homeAddress', 'message': '自宅住所を入力してください'},
            {'field': 'homeAddress', 'message': '2件目は使わない'},
            {'field': 'preparationTimeMinutes', 'message': '0〜180で入力してください'},
          ],
        ),
      );

      final error = await _failure(() => _api(adapter).profile.getProfile());

      expect(error.kind, ApiErrorKind.validation);
      expect(error.message, '入力内容を確認してください');
      expect(error.statusCode, 400);
      expect(error.requestId, 'req-1');
      expect(error.fieldErrors, {
        'homeAddress': '自宅住所を入力してください',
        'preparationTimeMinutes': '0〜180で入力してください',
      });
    });

    const codes = {
      'UNAUTHORIZED': (401, ApiErrorKind.unauthorized),
      'NOT_FOUND': (404, ApiErrorKind.notFound),
      'CONFLICT': (409, ApiErrorKind.conflict),
      'RATE_LIMITED': (429, ApiErrorKind.rateLimited),
      'EXTERNAL_SERVICE_ERROR': (502, ApiErrorKind.externalService),
      'FEATURE_DISABLED': (501, ApiErrorKind.featureDisabled),
      'INTERNAL_ERROR': (500, ApiErrorKind.server),
    };
    for (final MapEntry(key: code, value: (status, kind)) in codes.entries) {
      test('$code（$status）は ${kind.name} になる', () async {
        final adapter = FakeHttpAdapter.json(status, _errorBody(code));

        final error = await _failure(() => _api(adapter).profile.getProfile());

        expect(error.kind, kind);
        expect(error.message, 'メッセージ');
        expect(error.fieldErrors, isEmpty);
      });
    }

    test('共通エラー形式でない応答（ALB のエラーページなど）は server として扱う', () async {
      final adapter = FakeHttpAdapter(
        (_) => ResponseBody.fromString(
          '<html>502 Bad Gateway</html>',
          502,
          headers: {
            Headers.contentTypeHeader: ['text/html'],
          },
        ),
      );

      final error = await _failure(() => _api(adapter).profile.getProfile());

      expect(error.kind, ApiErrorKind.server);
      expect(error.message, ApiException.unexpectedMessage);
      expect(error.statusCode, 502);
    });

    test('サーバに届かないときは network になる', () async {
      final error = await _failure(
        () => _api(FakeHttpAdapter.connectionError()).profile.getProfile(),
      );

      expect(error.kind, ApiErrorKind.network);
      expect(error.message, ApiException.networkMessage);
    });

    test('時間内に応答がないときは timeout になる', () async {
      final adapter = FakeHttpAdapter(
        (options) => throw DioException.receiveTimeout(
          timeout: const Duration(seconds: 30),
          requestOptions: options,
        ),
      );

      final error = await _failure(() => _api(adapter).profile.getProfile());

      expect(error.kind, ApiErrorKind.timeout);
      expect(error.message, ApiException.timeoutMessage);
    });

    test('応答の形が仕様と違うときは server として扱う', () async {
      final adapter = FakeHttpAdapter.json(200, {'unexpected': true});

      final error = await _failure(() => _api(adapter).profile.getProfile());

      expect(error.kind, ApiErrorKind.server);
    });
  });
}
