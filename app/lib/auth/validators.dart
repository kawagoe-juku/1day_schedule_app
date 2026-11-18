import 'auth_service.dart';

/// 認証画面の入力チェック。問題がなければ null、あればその場に出すメッセージを返す。
abstract final class AuthValidators {
  static final _emailPattern = RegExp(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$",
  );
  static final _codePattern = RegExp(r'^[0-9]{6}$');

  /// パスワードの最小の長さ（Cognito の設定と同じ）
  static const passwordMinLength = 8;

  /// 確認コードの桁数
  static const codeLength = 6;

  static String? email(String value) {
    final email = value.trim();
    if (email.isEmpty) return 'メールアドレスを入力してください';
    if (!_emailPattern.hasMatch(email)) return 'メールアドレスの形式が正しくありません';
    return null;
  }

  /// サインインのパスワード（決まりは確かめない。昔の決まりで作ったパスワードも通すため）
  static String? currentPassword(String value) =>
      value.isEmpty ? 'パスワードを入力してください' : null;

  /// 新しく決めるパスワード（サインアップ・パスワードリセット）
  static String? newPassword(String value) {
    if (value.isEmpty) return 'パスワードを入力してください';
    final ok =
        value.length >= passwordMinLength &&
        value.contains(RegExp('[A-Z]')) &&
        value.contains(RegExp('[a-z]')) &&
        value.contains(RegExp('[0-9]'));
    return ok ? null : passwordPolicyMessage;
  }

  static String? code(String value) {
    final code = value.trim();
    if (code.isEmpty) return '確認コードを入力してください';
    if (!_codePattern.hasMatch(code)) return '確認コードは6桁の数字で入力してください';
    return null;
  }
}
