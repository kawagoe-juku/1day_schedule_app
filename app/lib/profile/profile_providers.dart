import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/generated/api.dart';

/// ログイン中の利用者のプロファイル。取り直すときは `ref.invalidate(profileProvider)`。
final profileProvider = FutureProvider.autoDispose<Profile>(
  (ref) => ref.watch(apiProvider).profile.getProfile(),
);

/// 準備時間（分）の範囲。サーバの入力チェック（server/src/routes/profile.ts）と合わせる。
const preparationTimeMin = 0;
const preparationTimeMax = 180;

/// よく使う駅を登録できる件数の上限（要件 2.2.1）。
const maxFrequentStations = 20;

/// 自宅住所の文字数の上限（DB の列の長さ）。
const homeAddressMaxLength = 255;

/// 駅名の文字数の上限（サーバの入力チェックと合わせる）。
const stationNameMaxLength = 100;

/// 徒歩速度の表示名（要件 2.2.1：遅い／標準／速い）。
String walkingSpeedLabel(WalkingSpeed speed) => switch (speed) {
  WalkingSpeed.slow => '遅い',
  WalkingSpeed.normal => '標準',
  WalkingSpeed.fast => '速い',
};

/// 優先条件の表示名（要件 2.2.1：遅刻厳禁／節約重視／ポイント優先）。
String priorityConditionLabel(PriorityCondition condition) =>
    switch (condition) {
      PriorityCondition.onTime => '遅刻厳禁',
      PriorityCondition.saveMoney => '節約重視',
      PriorityCondition.points => 'ポイント優先',
    };

/// 準備時間の入力チェック。問題がなければ null を返す。
String? validatePreparationTime(String input) {
  final text = input.trim();
  if (text.isEmpty) return '準備時間を入力してください';
  // 半角数字だけを受け付ける（全角数字・符号・小数は不可）
  if (!RegExp(r'^[0-9]+$').hasMatch(text)) return '準備時間は半角数字で入力してください';
  final minutes = int.tryParse(text);
  if (minutes == null ||
      minutes < preparationTimeMin ||
      minutes > preparationTimeMax) {
    return '準備時間は$preparationTimeMin〜$preparationTimeMax分で入力してください';
  }
  return null;
}
