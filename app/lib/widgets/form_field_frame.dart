import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// 入力項目の枠。上にラベル（必須なら赤い `*`）、下に入力エラーを出す。
/// ラベルと必須かどうかは、読み上げ用の名前として入力欄にも付ける。
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
          // 見た目のラベル。読み上げは下の入力欄に付けるので、ここは読み上げない（二重に読まれないように）
          ExcludeSemantics(
            child: Text.rich(
              TextSpan(
                text: label,
                children: [
                  if (required)
                    const TextSpan(
                      text: ' *',
                      style: TextStyle(color: AppColors.danger),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          // 入力欄そのものに名前を付ける。スクリーンリーダーで入力欄に直接移っても、何の項目か分かる
          Semantics(label: required ? '$label（必須）' : label, child: child),
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
