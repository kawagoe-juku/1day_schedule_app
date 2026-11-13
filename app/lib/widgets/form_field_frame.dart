import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// 入力項目の枠。上にラベル（必須なら赤い `*`）、下に入力エラーを出す。
///
/// テキスト入力のエラーは `InputDecoration.errorText` でも出せるが、ラジオボタンや
/// チェックボックスなど入力欄の種類によらず同じ見た目にするため、この部品で出す。
/// [errorText] には、画面側の入力チェックの結果か、サーバが返した項目別のエラー
/// （`ApiException.fieldErrors`）を渡す。
class FormFieldFrame extends StatelessWidget {
  const FormFieldFrame({
    super.key,
    required this.label,
    required this.child,
    this.required = false,
    this.errorText,
  });

  final String label;

  /// 必須項目なら true（ラベルに `*` を付ける）
  final bool required;

  /// 入力エラー。null なら出さない
  final String? errorText;

  /// 入力欄
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final errorText = this.errorText;
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text.rich(
            TextSpan(
              text: label,
              children: [
                if (required)
                  const TextSpan(
                    text: ' *',
                    style: TextStyle(color: AppColors.danger),
                    semanticsLabel: '（必須）',
                  ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          child,
          if (errorText != null) FieldErrorText(errorText),
        ],
      ),
    );
  }
}

/// 入力欄のすぐ下に出す入力エラー。
class FieldErrorText extends StatelessWidget {
  const FieldErrorText(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Semantics(
        liveRegion: true,
        child: Text(
          message,
          style: const TextStyle(color: AppColors.danger, fontSize: 13),
        ),
      ),
    );
  }
}
