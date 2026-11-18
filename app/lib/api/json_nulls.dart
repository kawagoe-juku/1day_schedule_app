/// JSON から、値が null の項目を取り除く（入れ子の中も）。配列の要素の null は残す。
///
/// 生成した API の型（lib/api/generated）は、null を許す項目を「省略できる項目」として
/// 読むように作ってある（scripts/openapi-for-dart.mjs）。サーバは null をそのまま返すので、
/// 型に渡す前にこの関数で取り除く。
Object? removeJsonNulls(Object? json) {
  if (json is Map) {
    return <String, Object?>{
      for (final entry in json.entries)
        if (entry.value != null)
          entry.key as String: removeJsonNulls(entry.value),
    };
  }
  if (json is List) {
    return <Object?>[for (final item in json) removeJsonNulls(item)];
  }
  return json;
}
