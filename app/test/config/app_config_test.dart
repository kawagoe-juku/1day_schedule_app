import 'package:ai_schedule_app/config/app_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('指定がなければ手元（local）として扱う', () {
    expect(AppConfig.fromEnvironment().env, AppEnv.local);
  });

  test('どの環境でも、既定では画面と同じドメインにつなぐ', () {
    for (final name in ['local', 'dev', 'stg', 'prod']) {
      final config = AppConfig.resolve(envName: name);

      expect(config.env.name, name);
      expect(config.apiBaseUrl, '', reason: name);
    }
  });

  test('接続先を上書きできる', () {
    final config = AppConfig.resolve(
      envName: 'local',
      apiBaseUrlOverride: 'https://dev.example.com',
    );

    expect(config.apiBaseUrl, 'https://dev.example.com');
  });

  test('知らない環境名はエラーにする', () {
    expect(() => AppConfig.resolve(envName: 'production'), throwsArgumentError);
  });
}
