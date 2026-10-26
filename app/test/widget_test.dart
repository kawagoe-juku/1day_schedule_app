import 'package:flutter_test/flutter_test.dart';

import 'package:ai_schedule_app/main.dart';

void main() {
  testWidgets('アプリ名を表示する', (tester) async {
    await tester.pumpWidget(const App());

    expect(find.text(appTitle), findsOneWidget);
  });
}
