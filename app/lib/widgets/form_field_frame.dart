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
    this.labelsChild = true,
    this.footer,
  });

  /// 入力欄に付ける読み上げ用の名前。必須なら「（必須）」を付ける。
  static String semanticLabelOf(String label, {bool required = false}) =>
      required ? '$label（必須）' : label;

  final String label;

  /// 必須項目なら true（ラベルに `*` を付ける）
  final bool required;

  /// 入力エラー。null なら出さない
  final String? errorText;

  /// 入力欄
  final Widget child;

  /// [child] 全体に読み上げ用の名前を付けるか。
  ///
  /// [child] が入力欄のほかに補足や一覧を含むときは false にし、入力欄そのものに
  /// [semanticLabelOf] の名前を付ける（全体に付けると、入力欄に名前が付かなくなる）。
  final bool labelsChild;

  /// 入力エラーの下に出すもの（補足の文など）。入力エラーは、必ず入力欄のすぐ下に出す
  final Widget? footer;

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
          if (labelsChild)
            Semantics(
              label: semanticLabelOf(label, required: required),
              child: child,
            )
          else
            child,
          if (errorText != null) FieldErrorText(errorText),
          if (footer case final footer?) ...[const SizedBox(height: 4), footer],
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
