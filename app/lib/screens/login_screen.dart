import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_service.dart';
import '../auth/session_controller.dart';
import '../auth/validators.dart';
import '../theme/app_theme.dart';
import '../widgets/app_frame.dart';
import '../widgets/form_field_frame.dart';
import '../widgets/load_error_view.dart';
import 'password_reset_dialog.dart';

/// 2.2.1 ログイン画面（サインイン・サインアップ・パスワードリセット）。
///
/// ログインできると、画面遷移の制御（app_router.dart）がホームまたは初回設定へ送る。
class LoginScreen extends ConsumerWidget {
  const LoginScreen({super.key});

  static const title = 'ログイン';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionControllerProvider);
    return AppFrame(
      title: title,
      child: switch (session) {
        SessionUnavailable() => LoadErrorView(
          onRetry: () => ref.read(sessionControllerProvider.notifier).retry(),
        ),
        SessionSignedOut() => const _AuthTabs(),
        // 状態の確認中と、ログイン直後に画面が切り替わるまでの間
        SessionLoading() || SessionSignedIn() => const Padding(
          padding: EdgeInsets.symmetric(vertical: 32),
          child: Center(
            child: CircularProgressIndicator(semanticsLabel: '読み込み中'),
          ),
        ),
      },
    );
  }
}

enum _AuthMode { signIn, signUp }

class _AuthTabs extends ConsumerStatefulWidget {
  const _AuthTabs();

  @override
  ConsumerState<_AuthTabs> createState() => _AuthTabsState();
}

class _AuthTabsState extends ConsumerState<_AuthTabs> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _code = TextEditingController();

  var _mode = _AuthMode.signIn;

  /// サインアップで、確認コードの入力待ちになっているか
  var _awaitingCode = false;
  var _submitting = false;

  String? _emailError;
  String? _passwordError;
  String? _codeError;

  /// 項目に結び付かないお知らせ（コードを送った、など）
  String? _notice;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _code.dispose();
    super.dispose();
  }

  void _clearMessages() {
    _emailError = null;
    _passwordError = null;
    _codeError = null;
    _notice = null;
  }

  void _switchMode(_AuthMode mode) {
    if (_mode == mode || _submitting) return;
    setState(() {
      _mode = mode;
      _awaitingCode = false;
      _code.clear();
      _clearMessages();
    });
  }

  /// 入力チェック。問題があれば、その場にメッセージを出して false を返す（通信しない）。
  bool _validate() {
    final signUp = _mode == _AuthMode.signUp;
    setState(() {
      _clearMessages();
      _emailError = AuthValidators.email(_email.text);
      _passwordError = signUp
          ? AuthValidators.newPassword(_password.text)
          : AuthValidators.currentPassword(_password.text);
      if (_awaitingCode) _codeError = AuthValidators.code(_code.text);
    });
    return _emailError == null && _passwordError == null && _codeError == null;
  }

  /// 失敗を、関係する入力欄のすぐ下に出す。
  void _showFailure(AuthFailure failure) {
    setState(() {
      switch (failure.kind) {
        case AuthFailureKind.emailAlreadyUsed:
          _emailError = failure.message;
        case AuthFailureKind.codeMismatch || AuthFailureKind.codeExpired:
          _codeError = failure.message;
        default:
          // パスワードの誤りなど。確認コードの入力中なら、その欄の下に出す
          if (_awaitingCode) {
            _codeError = failure.message;
          } else {
            _passwordError = failure.message;
          }
      }
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _submitting = true);
    try {
      await action();
    } on AuthFailure catch (failure) {
      if (mounted) _showFailure(failure);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _submit() async {
    if (_submitting || !_validate()) return;
    final email = _email.text.trim();
    final password = _password.text;
    final session = ref.read(sessionControllerProvider.notifier);
    final auth = ref.read(authServiceProvider);

    await _run(() async {
      if (_awaitingCode) {
        await session.confirmSignUpAndSignIn(
          email: email,
          password: password,
          code: _code.text.trim(),
        );
      } else if (_mode == _AuthMode.signUp) {
        await auth.signUp(email: email, password: password);
        if (!mounted) return;
        setState(() {
          _awaitingCode = true;
          _notice = '確認コードをメールで送りました。届いた6桁の数字を入力してください';
        });
      } else {
        final outcome = await session.signIn(email: email, password: password);
        if (outcome == SignInOutcome.confirmationRequired && mounted) {
          // 確認コードが未入力のアカウント。サインアップの続き（コード入力）へ進める
          setState(() {
            _mode = _AuthMode.signUp;
            _awaitingCode = true;
            _notice = 'メールアドレスの確認が済んでいません。メールで届いた確認コードを入力してください';
          });
        }
      }
    });
  }

  Future<void> _resendCode() async {
    if (_submitting) return;
    final emailError = AuthValidators.email(_email.text);
    if (emailError != null) {
      setState(() => _emailError = emailError);
      return;
    }
    await _run(() async {
      await ref
          .read(authServiceProvider)
          .resendSignUpCode(email: _email.text.trim());
      if (!mounted) return;
      setState(() {
        _clearMessages();
        _notice = '確認コードを送り直しました';
      });
    });
  }

  Future<void> _openPasswordReset() async {
    final completed = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => PasswordResetDialog(initialEmail: _email.text),
    );
    if (completed == true && mounted) {
      setState(() {
        _clearMessages();
        _password.clear();
        _notice = 'パスワードをリセットしました。新しいパスワードでサインインしてください';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final signUp = _mode == _AuthMode.signUp;
    final notice = _notice;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: AutofillGroup(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  _ModeTab(
                    label: 'サインイン',
                    selected: !signUp,
                    onTap: () => _switchMode(_AuthMode.signIn),
                  ),
                  _ModeTab(
                    label: 'サインアップ',
                    selected: signUp,
                    onTap: () => _switchMode(_AuthMode.signUp),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              FormFieldFrame(
                label: 'メールアドレス',
                required: true,
                errorText: _emailError,
                child: TextField(
                  key: const Key('auth-email'),
                  controller: _email,
                  // 確認コードの入力中は、送り先を変えられないようにする
                  enabled: !_awaitingCode,
                  keyboardType: TextInputType.emailAddress,
                  autofillHints: const [AutofillHints.email],
                  textInputAction: TextInputAction.next,
                ),
              ),
              FormFieldFrame(
                label: 'パスワード',
                required: true,
                errorText: _passwordError,
                child: TextField(
                  key: const Key('auth-password'),
                  controller: _password,
                  enabled: !_awaitingCode,
                  obscureText: true,
                  autofillHints: [
                    signUp ? AutofillHints.newPassword : AutofillHints.password,
                  ],
                  decoration: InputDecoration(
                    helperText: signUp ? '8文字以上。大文字・小文字・数字を含める' : null,
                  ),
                  onSubmitted: (_) => _submit(),
                ),
              ),
              if (_awaitingCode)
                FormFieldFrame(
                  label: '確認コード',
                  required: true,
                  errorText: _codeError,
                  child: TextField(
                    key: const Key('auth-code'),
                    controller: _code,
                    keyboardType: TextInputType.number,
                    maxLength: AuthValidators.codeLength,
                    autofillHints: const [AutofillHints.oneTimeCode],
                    inputFormatters: [
                      LengthLimitingTextInputFormatter(
                        AuthValidators.codeLength,
                      ),
                    ],
                    decoration: const InputDecoration(
                      hintText: '6桁',
                      counterText: '',
                    ),
                    onSubmitted: (_) => _submit(),
                  ),
                ),
              if (notice != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Semantics(
                    liveRegion: true,
                    child: Text(
                      notice,
                      style: const TextStyle(
                        color: AppColors.textMuted,
                        fontSize: 14,
                      ),
                    ),
                  ),
                ),
              if (!signUp)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: _submitting ? null : _openPasswordReset,
                    child: const Text(
                      'パスワードを忘れた場合',
                      style: TextStyle(decoration: TextDecoration.underline),
                    ),
                  ),
                ),
              if (_awaitingCode)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: _submitting ? null : _resendCode,
                    child: const Text(
                      '確認コードを再送',
                      style: TextStyle(decoration: TextDecoration.underline),
                    ),
                  ),
                ),
              const SizedBox(height: 8),
              FilledButton(
                key: const Key('auth-submit'),
                onPressed: _submitting ? null : _submit,
                child: Text(
                  _submitting
                      ? '処理中…'
                      : signUp
                      ? (_awaitingCode ? 'サインアップ（確認コードを送信）' : 'サインアップ')
                      : 'サインイン',
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// サインイン／サインアップの切替タブ（画面の見本の nav-tabs）。
class _ModeTab extends StatelessWidget {
  const _ModeTab({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Semantics(
        button: true,
        selected: selected,
        child: InkWell(
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: AppSizes.tapTarget),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: selected ? AppColors.primary : AppColors.border,
                  width: selected ? 2 : 1,
                ),
              ),
            ),
            child: Text(
              label,
              style: TextStyle(
                fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
                color: selected ? AppColors.text : AppColors.textMuted,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
