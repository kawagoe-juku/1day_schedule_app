import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 接続先の環境。ビルド時に `--dart-define=APP_ENV=dev` のように指定する。
enum AppEnv {
  /// 手元（`npm run app:dev`）。指定がないときの既定
  local,

  /// 開発環境
  dev,

  /// 検証環境
  stg,

  /// 本番環境
  prod;

  /// 環境名（`local`・`dev`・`stg`・`prod`）から求める。知らない名前はビルドの指定ミスなのでエラーにする。
  static AppEnv parse(String name) {
    for (final env in AppEnv.values) {
      if (env.name == name) return env;
    }
    throw ArgumentError.value(
      name,
      'APP_ENV',
      'local・dev・stg・prod のいずれかを指定してください',
    );
  }
}

/// 環境ごとに変わる設定値。
class AppConfig {
  const AppConfig({required this.env, required this.apiBaseUrl});

  /// 環境名と、接続先の上書き（空なら既定）から作る。
  ///
  /// 既定の接続先は、どの環境でも空文字（＝画面と同じドメイン）。
  /// 開発・検証・本番では CloudFront が、手元では画面の開発サーバ（web_dev_config.yaml）が、
  /// /api・/agent をサーバへ転送する。
  factory AppConfig.resolve({
    required String envName,
    String apiBaseUrlOverride = '',
  }) => AppConfig(env: AppEnv.parse(envName), apiBaseUrl: apiBaseUrlOverride);

  /// ビルド時の指定（`--dart-define`）から作る。
  ///
  /// - `APP_ENV`：環境名。既定は `local`
  /// - `API_BASE_URL`：接続先の上書き。画面と API を別のドメインで動かすときだけ使う
  factory AppConfig.fromEnvironment() => AppConfig.resolve(
    envName: const String.fromEnvironment('APP_ENV', defaultValue: 'local'),
    apiBaseUrlOverride: const String.fromEnvironment('API_BASE_URL'),
  );

  final AppEnv env;

  /// API の接続先。末尾に `/` を付けない。空文字は「画面と同じドメイン」を表す。
  final String apiBaseUrl;
}

/// アプリの設定値。テストでは `overrideWithValue` で差し替える。
final appConfigProvider = Provider<AppConfig>(
  (ref) => AppConfig.fromEnvironment(),
);
