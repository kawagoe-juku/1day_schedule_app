import 'package:flutter/material.dart';

/// 利用規約・プライバシーポリシーの種類。
enum LegalDocument {
  terms('利用規約'),
  privacy('プライバシーポリシー');

  const LegalDocument(this.title);

  final String title;
}

/// 利用規約・プライバシーポリシーを、いまの画面の上に重ねて表示する。
///
/// 別の画面へ移らないので、初回設定の入力途中でも内容を確かめられる。
/// 本文は WBS 1.12（利用規約・プライバシーポリシーの作成）で確定したら差し替える。
Future<void> showLegalDocument(BuildContext context, LegalDocument document) =>
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(document.title),
        content: SingleChildScrollView(
          child: Text(legalDocumentBody(document)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('閉じる'),
          ),
        ],
      ),
    );

/// 本文。確定するまでは準備中の案内を出す。
String legalDocumentBody(LegalDocument document) =>
    '${document.title}は準備中です。内容が確定したら、この画面に掲載します。';
