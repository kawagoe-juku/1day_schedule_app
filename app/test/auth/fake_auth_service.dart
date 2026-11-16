import 'package:ai_schedule_app/auth/auth_service.dart';
import 'package:ai_schedule_app/auth/session_controller.dart';

/// メモリ上で動く認証の代用品（Cognito と同じふるまいを、テストに必要な範囲でまねる）。
class FakeAuthService implements AuthService {
  /// サインアップ・パスワードリセットで「メールに届く」確認コード
  static const validCode = '123456';

  /// 登録済みの利用者（メールアドレス → パスワード・確認済みか）
  final users = <String, ({String password, bool confirmed})>{};

  /// ログイン中の利用者のメールアドレス
  String? signedInEmail;

  /// 呼ばれた操作の記録（例：`signUp:new@example.com`）
  final calls = <String>[];

  /// 次の操作を、この種類の失敗にする（1回だけ）
  AuthFailureKind? failNext;

  /// 操作の名前（`signIn` など）ごとに、次の1回をこの種類の失敗にする
  final failOn = <String, AuthFailureKind>{};

  /// true にすると、ログインの有効期限が切れた状態になる（トークンを取ろうとすると、ログイン情報が消える）
  bool sessionExpired = false;

  /// トークンの更新を、この種類の失敗にする（通信できないなど。ログインは切れない）
  AuthFailureKind? tokenFailure;

  AuthSettings? settings;

  void addUser(String email, String password, {bool confirmed = true}) =>
      users[email] = (password: password, confirmed: confirmed);

  void _record(String call) {
    calls.add(call);
    final failure = failNext ?? failOn.remove(call.split(':').first);
    if (failure != null) {
      failNext = null;
      throw AuthFailure(failure);
    }
  }

  @override
  Future<void> initialize(AuthSettings config) async => settings = config;

  @override
  Future<bool> isSignedIn() async => signedInEmail != null;

  @override
  Future<String?> getAccessToken() async {
    final failure = tokenFailure;
    if (failure != null) throw AuthFailure(failure);
    if (sessionExpired) signedInEmail = null;
    return signedInEmail == null ? null : 'token-$signedInEmail';
  }

  @override
  Future<void> signUp({required String email, required String password}) async {
    _record('signUp:$email');
    if (users.containsKey(email)) {
      throw const AuthFailure(AuthFailureKind.emailAlreadyUsed);
    }
    addUser(email, password, confirmed: false);
  }

  @override
  Future<void> confirmSignUp({
    required String email,
    required String code,
  }) async {
    _record('confirmSignUp:$email:$code');
    if (code != validCode) {
      throw const AuthFailure(AuthFailureKind.codeMismatch);
    }
    users[email] = (password: users[email]!.password, confirmed: true);
  }

  @override
  Future<void> resendSignUpCode({required String email}) async =>
      _record('resendSignUpCode:$email');

  @override
  Future<SignInOutcome> signIn({
    required String email,
    required String password,
  }) async {
    _record('signIn:$email');
    final user = users[email];
    if (user == null || user.password != password) {
      throw const AuthFailure(AuthFailureKind.invalidCredentials);
    }
    if (!user.confirmed) return SignInOutcome.confirmationRequired;
    signedInEmail = email;
    return SignInOutcome.signedIn;
  }

  @override
  Future<void> signOut() async {
    _record('signOut');
    signedInEmail = null;
  }

  @override
  Future<void> requestPasswordReset({required String email}) async =>
      _record('requestPasswordReset:$email');

  @override
  Future<void> confirmPasswordReset({
    required String email,
    required String code,
    required String newPassword,
  }) async {
    _record('confirmPasswordReset:$email:$code');
    if (code != validCode) {
      throw const AuthFailure(AuthFailureKind.codeMismatch);
    }
    final user = users[email];
    if (user != null) users[email] = (password: newPassword, confirmed: true);
  }
}

/// メモリ上の「最後に操作した時刻」。
class MemoryActivityStore implements ActivityStore {
  DateTime? value;

  @override
  Future<DateTime?> read() async => value;

  @override
  Future<void> write(DateTime time) async => value = time;

  @override
  Future<void> clear() async => value = null;
}
