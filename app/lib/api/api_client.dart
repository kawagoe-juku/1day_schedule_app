import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/session_controller.dart';
import '../config/app_config.dart';
import 'api_exception.dart';
import 'generated/api.dart';
import 'json_nulls.dart';

/// ログイン中の利用者のアクセストークン（JWT）を返す関数。未ログインなら null を返す。
typedef AccessTokenGetter = Future<String?> Function();

/// サーバにつながるまでの待ち時間の上限。
const apiConnectTimeout = Duration(seconds: 10);

/// 応答を待つ時間の上限。行動計画の生成のように長くかかる API は、呼び出し側で個別に延ばす。
const apiReceiveTimeout = Duration(seconds: 30);

/// 生成した API クライアントが、認証の要否を入れてくるキー。
const _securityExtraKey = 'openapi.security';

/// API 用の通信クライアントを作る。
///
/// - 認証が必要な API にだけ `Authorization: Bearer <JWT>` を付ける
/// - 応答の JSON から null の項目を取り除く（[removeJsonNulls]）
/// - 失敗を [ApiException] に変換する（`DioException.error` に入れる。
///   呼び出し側は `ApiException.from(error)` で取り出す）
Dio createApiDio({
  required AppConfig config,
  required AccessTokenGetter getAccessToken,
  HttpClientAdapter? httpClientAdapter,
}) {
  final dio = Dio(
    BaseOptions(
      baseUrl: config.apiBaseUrl,
      connectTimeout: apiConnectTimeout,
      receiveTimeout: apiReceiveTimeout,
    ),
  );
  if (httpClientAdapter != null) dio.httpClientAdapter = httpClientAdapter;

  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) async {
        final security = options.extra[_securityExtraKey];
        if (security is List && security.isNotEmpty) {
          final token = await getAccessToken();
          if (token != null) {
            options.headers['Authorization'] = 'Bearer $token';
          }
        }
        handler.next(options);
      },
      onResponse: (response, handler) {
        response.data = removeJsonNulls(response.data);
        handler.next(response);
      },
      onError: (error, handler) {
        handler.next(error.copyWith(error: ApiException.fromDio(error)));
      },
    ),
  );
  return dio;
}

/// アクセストークンの取得方法。既定ではログインの状態（SessionController）から取得する。
final accessTokenGetterProvider = Provider<AccessTokenGetter>(
  (ref) =>
      () => ref.read(sessionControllerProvider.notifier).getAccessToken(),
);

/// API 用の通信クライアント。テストでは `overrideWithValue` で差し替える。
final apiDioProvider = Provider<Dio>((ref) {
  final dio = createApiDio(
    config: ref.watch(appConfigProvider),
    getAccessToken: ref.watch(accessTokenGetterProvider),
  );
  ref.onDispose(dio.close);
  return dio;
});

/// API クライアント。`ref.watch(apiProvider).profile.getProfile()` のように使う。
final apiProvider = Provider<Api>((ref) => Api(ref.watch(apiDioProvider)));
