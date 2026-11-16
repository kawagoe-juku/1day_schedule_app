import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../api/api_exception.dart';
import 'amplify_auth_service.dart';
import 'auth_service.dart';

/// 無操作でログインを打ち切るまでの時間（要件 3.3.1：無操作24時間）。
///
/// 「操作」は API の呼び出しで数える。最後の呼び出しからこの時間が過ぎていたら、
/// 次の起動時または次の API 呼び出しの前にログアウトする。
const sessionIdleTimeout = Duration(hours: 24);

/// ログインの状態。
sealed class SessionState {
  const SessionState();
}

/// 起動直後やログイン直後で、状態を確かめている
class SessionLoading extends SessionState {
  const SessionLoading();
}

/// 状態を確かめられなかった（通信できないなど）。[SessionController.retry] でやり直す
class SessionUnavailable extends SessionState {
  const SessionUnavailable();
}

class SessionSignedOut extends SessionState {
  const SessionSignedOut();
}

class SessionSignedIn extends SessionState {
  const SessionSignedIn({required this.onboardingCompleted});

  /// 初回設定（オンボーディング）が済んでいるか。済んでいなければ初回設定の画面へ送る
  final bool onboardingCompleted;
}

/// 最後に操作した時刻の保存先（ブラウザに残し、タブを閉じても引き継ぐ）。
abstract interface class ActivityStore {
  Future<DateTime?> read();
  Future<void> write(DateTime time);
  Future<void> clear();
}

class _PreferencesActivityStore implements ActivityStore {
  static const _key = 'session.lastActiveAt';

  @override
  Future<DateTime?> read() async {
    final millis = (await SharedPreferences.getInstance()).getInt(_key);
    return millis == null ? null : DateTime.fromMillisecondsSinceEpoch(millis);
  }

  @override
  Future<void> write(DateTime time) async {
    await (await SharedPreferences.getInstance()).setInt(
      _key,
      time.millisecondsSinceEpoch,
    );
  }

  @override
  Future<void> clear() async {
    await (await SharedPreferences.getInstance()).remove(_key);
  }
}

/// 認証の実体。テストでは代用品に差し替える。
final authServiceProvider = Provider<AuthService>(
  (ref) => AmplifyAuthService(),
);

final activityStoreProvider = Provider<ActivityStore>(
  (ref) => _PreferencesActivityStore(),
);

/// 現在時刻。テストで時刻を進めるために差し替える。
final clockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// ログインの状態を管理する。画面遷移の制御（app_router.dart）もこの状態を見る。
final sessionControllerProvider =
    NotifierProvider<SessionController, SessionState>(SessionController.new);

class SessionController extends Notifier<SessionState> {
  AuthService get _auth => ref.read(authServiceProvider);
  ActivityStore get _activity => ref.read(activityStoreProvider);
  DateTime _now() => ref.read(clockProvider)();

  @override
  SessionState build() {
    // 起動時に、ブラウザに残っているログイン情報を確かめる
    Future.microtask(_restore);
    return const SessionLoading();
  }

  /// 状態の確認をやり直す（[SessionUnavailable] のときの「再試行」）。
  Future<void> retry() {
    state = const SessionLoading();
    return _restore();
  }

  Future<void> _restore() async {
    try {
      final config =
          (await ref.read(apiProvider).account.getAppConfig()).cognito;
      await _auth.initialize(
        AuthSettings(
          region: config.region,
          userPoolId: config.userPoolId,
          webClientId: config.webClientId,
        ),
      );
      if (!await _auth.isSignedIn()) {
        state = const SessionSignedOut();
      } else if (await _isIdleTooLong()) {
        await signOut();
      } else {
        await _enter();
      }
    } on Object {
      state = const SessionUnavailable();
    }
  }

  /// ログイン済みの利用者のプロファイルを確かめ、ログイン中の状態にする。
  Future<void> _enter() async {
    try {
      await _activity.write(_now());
      // 先にトークンを確かめる。期限切れなら、API を呼ぶ前にログアウトにする。
      // 一時的に更新できないだけなら AuthFailure になり、下でやり直せる状態にする
      if (await _auth.getAccessToken() == null) {
        await signOut();
        return;
      }
      final profile = await ref.read(apiProvider).profile.getProfile();
      state = SessionSignedIn(onboardingCompleted: profile.onboardingCompleted);
    } on Object catch (error) {
      if (error is! AuthFailure &&
          ApiException.from(error).kind == ApiErrorKind.unauthorized) {
        // ログイン情報が無効になっている（全端末ログアウト・退会など）
        await signOut();
      } else {
        state = const SessionUnavailable();
      }
    }
  }

  Future<bool> _isIdleTooLong() async {
    final lastActiveAt = await _activity.read();
    return lastActiveAt != null &&
        _now().difference(lastActiveAt) >= sessionIdleTimeout;
  }

  /// サインインする。確認コードが未入力のアカウントなら、ログインせずにその旨を返す。
  Future<SignInOutcome> signIn({
    required String email,
    required String password,
  }) async {
    final outcome = await _auth.signIn(email: email, password: password);
    if (outcome == SignInOutcome.signedIn) {
      state = const SessionLoading();
      await _enter();
    }
    return outcome;
  }

  Future<void> signOut() async {
    try {
      await _auth.signOut();
    } on AuthFailure {
      // サーバ側の取り消しに失敗しても、この端末のログイン情報は消えているので先へ進む
    }
    await _activity.clear();
    state = const SessionSignedOut();
  }

  /// 初回設定が終わったことを反映する（オンボーディングの完了時に呼ぶ）。
  void markOnboardingCompleted() {
    if (state is SessionSignedIn) {
      state = const SessionSignedIn(onboardingCompleted: true);
    }
  }

  /// API が 401 を返したときに呼ぶ。ログインが無効になっている（期限切れ・ほかの端末での
  /// ログアウト・退会など）ので、この端末もログアウトしてログイン画面へ戻す。
  Future<void> handleUnauthorized() async {
    if (state is SessionSignedIn) await signOut();
  }

  /// API に付けるアクセストークン。
  ///
  /// 無操作の時間が上限を超えていたとき、またはログインの有効期限が切れていたときは、
  /// ログアウトして null を返す。一時的な理由でトークンを更新できなかったときは
  /// [AuthFailure] を投げる（ログアウトはしない）。
  Future<String?> getAccessToken() async {
    final signedIn = state is SessionSignedIn;
    if (!signedIn && state is! SessionLoading) return null;
    if (await _isIdleTooLong()) {
      await signOut();
      return null;
    }
    final token = await _auth.getAccessToken();
    if (token == null) {
      // ログイン中のはずなのにトークンが無い＝ログインの有効期限が切れた
      if (signedIn) await signOut();
      return null;
    }
    // ログアウトの処理と重なったときに、消した記録を書き戻さない
    if (state is! SessionSignedOut) await _activity.write(_now());
    return token;
  }
}
