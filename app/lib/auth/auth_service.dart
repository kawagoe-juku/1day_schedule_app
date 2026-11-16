/// ログインまわりの失敗の種類。
enum AuthFailureKind {
  /// メールアドレスまたはパスワードが違う（未登録のメールアドレスも同じ扱い）
  invalidCredentials,

  /// 登録済みのメールアドレスでサインアップしようとした
  emailAlreadyUsed,

  /// パスワードが決まり（8文字以上・大文字・小文字・数字）を満たさない
  invalidPassword,

  /// 確認コードが違う
  codeMismatch,

  /// 確認コードの有効期限が切れた
  codeExpired,

  /// 管理者がパスワードをリセットした。パスワードリセットをしてからでないとログインできない
  passwordResetRequired,

  /// 短時間に試しすぎた
  tooManyAttempts,

  /// 通信できなかった
  network,

  /// 上記以外
  unknown,
}

/// ログインまわりの失敗。画面はこの型だけを扱う（認証ライブラリの例外は扱わない）。
class AuthFailure implements Exception {
  const AuthFailure(this.kind);

  final AuthFailureKind kind;

  /// 利用者にそのまま見せる日本語のメッセージ
  String get message => switch (kind) {
    AuthFailureKind.invalidCredentials => 'メールアドレスまたはパスワードが正しくありません',
    AuthFailureKind.emailAlreadyUsed => 'このメールアドレスは登録済みです',
    AuthFailureKind.invalidPassword => passwordPolicyMessage,
    AuthFailureKind.codeMismatch => '確認コードが正しくありません',
    AuthFailureKind.codeExpired => '確認コードの有効期限が切れています。コードを再送してください',
    AuthFailureKind.passwordResetRequired =>
      'パスワードの再設定が必要です。「パスワードを忘れた場合」から設定し直してください',
    AuthFailureKind.tooManyAttempts => '試行回数が多すぎます。しばらくしてから、もう一度お試しください',
    AuthFailureKind.network => '通信できませんでした。接続を確認して、もう一度お試しください',
    AuthFailureKind.unknown => 'エラーが発生しました。しばらくしてから、もう一度お試しください',
  };

  @override
  String toString() => 'AuthFailure(${kind.name})';
}

const passwordPolicyMessage = 'パスワードは8文字以上で、大文字・小文字・数字を含めてください';

/// サインインの結果。
enum SignInOutcome {
  /// ログインできた
  signedIn,

  /// サインアップの確認コードがまだ入力されていない（確認コードの入力へ進める）
  confirmationRequired,
}

/// 認証先（Cognito）の接続情報。`GET /api/config` で取得する。
class AuthSettings {
  const AuthSettings({
    required this.region,
    required this.userPoolId,
    required this.webClientId,
  });

  final String region;
  final String userPoolId;
  final String webClientId;
}

/// 認証（Cognito のメールアドレス＋パスワード）。
///
/// 実体は `AmplifyAuthService`。テストでは代用品に差し替える。
/// 失敗は [AuthFailure] を投げる。
abstract interface class AuthService {
  /// 接続先を設定する。ほかの操作の前に1回だけ呼ぶ。
  Future<void> initialize(AuthSettings config);

  /// ログイン中か（ブラウザに残っているログイン情報を含む）。
  Future<bool> isSignedIn();

  /// API に付けるアクセストークン（JWT）。期限が近ければ自動で更新する。
  ///
  /// - 未ログイン、またはログインの有効期限が切れている（更新もできない）なら null
  /// - 通信できないなどの一時的な理由で更新できなかったときは [AuthFailure] を投げる
  ///   （ログインは切れていないので、呼び出し側はログアウトさせない）
  Future<String?> getAccessToken();

  /// サインアップする。成功すると、確認コードがメールで届く。
  Future<void> signUp({required String email, required String password});

  /// 確認コードでアカウントを有効にする。
  Future<void> confirmSignUp({required String email, required String code});

  /// サインアップの確認コードを送り直す。
  Future<void> resendSignUpCode({required String email});

  Future<SignInOutcome> signIn({
    required String email,
    required String password,
  });

  Future<void> signOut();

  /// パスワードリセットの確認コードをメールで送る。
  Future<void> requestPasswordReset({required String email});

  /// 確認コードと新しいパスワードで、パスワードリセットを確定する。
  Future<void> confirmPasswordReset({
    required String email,
    required String code,
    required String newPassword,
  });
}
