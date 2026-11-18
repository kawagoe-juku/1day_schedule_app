import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_service.dart';
import '../auth/session_controller.dart';
import '../auth/validators.dart';
import '../theme/app_theme.dart';
import '../widgets/form_field_frame.dart';

/// 2.2.8 パスワードリセット（メールアドレス → 確認コード → 新しいパスワードの3ステップ）。
///
/// 完了すると true、キャンセルすると null を返して閉じる。
/// 確認コードが正しいかどうかは、Cognito の仕様で、新しいパスワードと一緒に送るまで分からない。
/// コードが違っていたら、ステップ2に戻してその欄の下にエラーを出す。
class PasswordResetDialog extends ConsumerStatefulWidget {
  const PasswordResetDialog({super.key, this.initialEmail = ''});

  /// ログイン画面で入力済みのメールアドレス
  final String initialEmail;

  static const stepCount = 3;

  @override
  ConsumerState<PasswordResetDialog> createState() =>
      _PasswordResetDialogState();
}

class _PasswordResetDialogState extends ConsumerState<PasswordResetDialog> {
  late final _email = TextEditingController(text: widget.initialEmail.trim());
  final _code = TextEditingController();
  final _password = TextEditingController();

  /// 1：メールアドレス、2：確認コード、3：新しいパスワード
  var _step = 1;
  var _submitting = false;
  String? _error;

  /// 確認コードを送ったメールアドレス。確定のときも、必ずこの値を使う
  /// （送信中に入力欄を書き換えても、送り先と食い違わないようにする）
  String? _sentEmail;

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _next() async {
    if (_submitting) return;
    final error = switch (_step) {
      1 => AuthValidators.email(_email.text),
      2 => AuthValidators.code(_code.text),
      _ => AuthValidators.newPassword(_password.text),
    };
    setState(() => _error = error);
    if (error != null) return;

    if (_step == 2) {
      setState(() => _step = 3);
      return;
    }

    final auth = ref.read(authServiceProvider);
    final email = _email.text.trim();
    setState(() => _submitting = true);
    try {
      if (_step == 1) {
        await auth.requestPasswordReset(email: email);
        if (!mounted) return;
        setState(() {
          _sentEmail = email;
          _step = 2;
        });
      } else {
        await auth.confirmPasswordReset(
          email: _sentEmail ?? email,
          code: _code.text.trim(),
          newPassword: _password.text,
        );
        if (mounted) Navigator.of(context).pop(true);
      }
    } on AuthFailure catch (failure) {
      if (!mounted) return;
      setState(() {
        final codeProblem =
            failure.kind == AuthFailureKind.codeMismatch ||
            failure.kind == AuthFailureKind.codeExpired;
        if (_step == 3 && codeProblem) _step = 2;
        _error = failure.message;
      });
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final field = switch (_step) {
      1 => FormFieldFrame(
        label: 'メールアドレス',
        required: true,
        errorText: _error,
        child: TextField(
          key: const Key('reset-email'),
          // 送信中は書き換えられないようにする
          enabled: !_submitting,
          controller: _email,
          autofocus: true,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          onSubmitted: (_) => _next(),
        ),
      ),
      2 => FormFieldFrame(
        label: '確認コード',
        required: true,
        errorText: _error,
        child: TextField(
          key: const Key('reset-code'),
          // 送信中は書き換えられないようにする
          enabled: !_submitting,
          controller: _code,
          autofocus: true,
          keyboardType: TextInputType.number,
          inputFormatters: [
            LengthLimitingTextInputFormatter(AuthValidators.codeLength),
          ],
          decoration: const InputDecoration(hintText: '6桁'),
          onSubmitted: (_) => _next(),
        ),
      ),
      _ => FormFieldFrame(
        label: '新しいパスワード',
        required: true,
        errorText: _error,
        child: TextField(
          key: const Key('reset-password'),
          // 送信中は書き換えられないようにする
          enabled: !_submitting,
          controller: _password,
          autofocus: true,
          obscureText: true,
          autofillHints: const [AutofillHints.newPassword],
          decoration: const InputDecoration(helperText: '8文字以上。大文字・小文字・数字を含める'),
          onSubmitted: (_) => _next(),
        ),
      ),
    };

    return AlertDialog(
      backgroundColor: AppColors.surface,
      title: const Text('パスワードリセット', style: TextStyle(fontSize: 18)),
      content: SizedBox(
        width: 400,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'ステップ $_step/${PasswordResetDialog.stepCount}',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 14),
            ),
            const SizedBox(height: 4),
            LinearProgressIndicator(
              value: _step / PasswordResetDialog.stepCount,
              color: AppColors.primary,
              backgroundColor: AppColors.border,
            ),
            const SizedBox(height: 16),
            if (_step == 2)
              const Padding(
                padding: EdgeInsets.only(bottom: 12),
                child: Text(
                  '登録済みのメールアドレスであれば、確認コードが届きます。',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 14),
                ),
              ),
            field,
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _submitting ? null : () => Navigator.of(context).pop(),
          child: const Text('キャンセル'),
        ),
        FilledButton(
          key: const Key('reset-next'),
          onPressed: _submitting ? null : _next,
          child: Text(_submitting ? '処理中…' : (_step == 3 ? '完了' : '次へ')),
        ),
      ],
    );
  }
}
