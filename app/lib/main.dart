import 'package:flutter/material.dart';

/// アプリの表示名。ブラウザのタブ名にも使われる。
const appTitle = 'AIスケジュール外出支援';

void main() {
  runApp(const App());
}

/// アプリのルート。画面は未実装のため、アプリ名だけを表示する。
class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: appTitle,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
      ),
      home: const Scaffold(body: Center(child: Text(appTitle))),
    );
  }
}
