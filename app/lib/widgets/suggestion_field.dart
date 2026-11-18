import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';
import 'load_error_view.dart';

/// 入力が止まってから候補を取りに行くまでの待ち時間（1文字ごとに API を呼ばない）。
const suggestionDebounce = Duration(milliseconds: 300);

/// 候補付きの入力欄（住所・駅名）。
///
/// 入力が止まると [search] を呼び、入力欄のすぐ下に候補を並べる。
/// 取得中は進行中の表示、0件なら「候補がありません」、失敗したら「取得に失敗しました」と
/// 再試行ボタンを、同じ領域に出す。候補を選ぶと [onSelected] を呼び、一覧を閉じる。
///
/// - 日本語入力の変換中（確定前）は取得しない。確定してから取得する
/// - キーボード：↓ で最初の候補へ移り、Enter で選ぶ。Esc で一覧を閉じる
///
/// 入力欄の文字は呼び出し側の [controller] が持つ。候補を選んだときに入力欄をどうするか
/// （選んだ内容を入れる・空に戻す）は、[onSelected] の中で呼び出し側が決める。
class SuggestionField<T> extends StatefulWidget {
  const SuggestionField({
    super.key,
    required this.controller,
    required this.search,
    required this.itemLabel,
    required this.onSelected,
    this.itemDetail,
    this.onChanged,
    this.onSubmitted,
    this.focusNode,
    this.fieldKey,
    this.semanticLabel,
    this.hintText,
    this.maxLength,
    this.maxQueryLength = defaultMaxQueryLength,
    this.searchOnFocus = false,
  });

  /// 候補の API が受け付ける検索文字の長さ（server/src/routes/geo.ts の `q`）。
  static const defaultMaxQueryLength = 100;

  final TextEditingController controller;

  /// 入力した文字から候補を取得する
  final Future<List<T>> Function(String query) search;

  /// 候補の表示名
  final String Function(T item) itemLabel;

  /// 候補の補足（都道府県など）。無ければ出さない
  final String? Function(T item)? itemDetail;

  final ValueChanged<T> onSelected;

  /// 利用者が入力欄を書き換えたとき（候補を選んだときは呼ばない）
  final ValueChanged<String>? onChanged;

  /// 入力欄で Enter を押したとき
  final VoidCallback? onSubmitted;

  /// 入力欄のフォーカス。呼び出し側からフォーカスを移したいときに渡す
  final FocusNode? focusNode;

  /// 入力欄のキー（テストで探すため）
  final Key? fieldKey;

  /// 入力欄の読み上げ用の名前（例：`自宅住所（必須）`）。
  /// 候補の一覧が開いていても、入力欄そのものに付く
  final String? semanticLabel;

  final String? hintText;
  final int? maxLength;

  /// 検索に使う文字数の上限。これより長い入力は、先頭からこの長さまでで検索する
  /// （住所は建物名まで入れると長くなるが、候補を出すには町名・番地までで足りる）
  final int maxQueryLength;

  /// true の間、入力欄にフォーカスが移ったときにも（文字が入っていれば）候補を取得する。
  /// 文字は入っているが候補をまだ選んでいない、という状態から選び直せるようにする
  final bool searchOnFocus;

  static const emptyMessage = '候補がありません';

  @override
  State<SuggestionField<T>> createState() => _SuggestionFieldState<T>();
}

enum _Status { idle, loading, loaded, failed }

class _SuggestionFieldState<T> extends State<SuggestionField<T>> {
  Timer? _debounce;
  _Status _status = _Status.idle;
  List<T> _items = const [];

  /// 最後に取得を始めた検索文字。再試行で使う
  String _query = '';

  /// 応答が前後して届いても、古い入力の結果は捨てるための番号
  int _requestId = 0;

  /// 入力欄の文字のうち、すでに扱った検索文字。カーソルの移動だけでは取得し直さない
  String _handledQuery = '';

  /// 候補を選んだ処理の途中（呼び出し側が入力欄を書き換えても、取得を始めない）
  bool _selecting = false;

  FocusNode? _ownFocusNode;
  FocusNode get _focusNode =>
      widget.focusNode ?? (_ownFocusNode ??= FocusNode());

  @override
  void initState() {
    super.initState();
    // 最初から入っている文字は「扱い済み」にする（開いただけでは取得しない）
    _handledQuery = _queryOf(widget.controller.text);
    widget.controller.addListener(_onValueChanged);
    _focusNode.addListener(_onFocusChanged);
  }

  @override
  void didUpdateWidget(SuggestionField<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onValueChanged);
      widget.controller.addListener(_onValueChanged);
      _handledQuery = _queryOf(widget.controller.text);
    }
    if (oldWidget.focusNode != widget.focusNode) {
      (oldWidget.focusNode ?? _ownFocusNode)?.removeListener(_onFocusChanged);
      _focusNode.addListener(_onFocusChanged);
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    widget.controller.removeListener(_onValueChanged);
    _focusNode.removeListener(_onFocusChanged);
    _ownFocusNode?.dispose();
    super.dispose();
  }

  /// 入力から検索文字を作る（前後の空白を除き、上限の長さで切る）。
  String _queryOf(String text) {
    final query = text.trim();
    return query.length <= widget.maxQueryLength
        ? query
        : query.substring(0, widget.maxQueryLength);
  }

  /// 入力欄の内容が変わったとき（文字・変換中の範囲・カーソルのどれが変わっても呼ばれる）。
  ///
  /// 文字の変化（`TextField.onChanged`）ではなく値全体を見るのは、日本語入力の確定を拾うため。
  /// 確定の瞬間は文字が変わらず、変換中の範囲だけが消える。
  void _onValueChanged() {
    if (_selecting) return;
    final value = widget.controller.value;
    if (value.composing.isValid && !value.composing.isCollapsed) {
      // 変換中。確定するまで取得しない（未確定のひらがなで API を呼ばない）
      _debounce?.cancel();
      return;
    }
    final query = _queryOf(value.text);
    if (query == _handledQuery) return;
    _handledQuery = query;
    _debounce?.cancel();
    if (query.isEmpty) {
      _close();
      return;
    }
    _debounce = Timer(suggestionDebounce, () => _load(query));
  }

  void _onFocusChanged() {
    if (!_focusNode.hasFocus || !widget.searchOnFocus) return;
    if (_status != _Status.idle || (_debounce?.isActive ?? false)) return;
    final query = _queryOf(widget.controller.text);
    if (query.isNotEmpty) _load(query);
  }

  Future<void> _load(String query) async {
    final requestId = ++_requestId;
    setState(() {
      _query = query;
      _status = _Status.loading;
    });
    try {
      final items = await widget.search(query);
      if (!mounted || requestId != _requestId) return;
      setState(() {
        _items = items;
        _status = _Status.loaded;
      });
    } on Object {
      if (!mounted || requestId != _requestId) return;
      setState(() => _status = _Status.failed);
    }
  }

  void _close() {
    _requestId++; // 取得中の応答が後から届いても、一覧を開き直さない
    if (_status == _Status.idle) return;
    setState(() {
      _status = _Status.idle;
      _items = const [];
    });
  }

  void _select(T item) {
    _debounce?.cancel();
    _close();
    _selecting = true;
    try {
      widget.onSelected(item);
    } finally {
      _selecting = false;
      _handledQuery = _queryOf(widget.controller.text);
    }
    // 候補の行は消えるので、フォーカスを入力欄に戻す（キーボード操作を続けられるように）
    _focusNode.requestFocus();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent || _status == _Status.idle) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      _debounce?.cancel();
      _close();
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown &&
        _status == _Status.loaded &&
        _items.isNotEmpty) {
      // 入力欄の次に並んでいるのが、最初の候補
      _focusNode.nextFocus();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Focus(
          canRequestFocus: false,
          skipTraversal: true,
          onKeyEvent: _onKey,
          child: Semantics(
            label: widget.semanticLabel,
            child: TextField(
              key: widget.fieldKey,
              controller: widget.controller,
              focusNode: _focusNode,
              maxLength: widget.maxLength,
              decoration: InputDecoration(
                hintText: widget.hintText,
                counterText: '',
              ),
              onChanged: widget.onChanged,
              onSubmitted: widget.onSubmitted == null
                  ? null
                  : (_) => widget.onSubmitted!(),
            ),
          ),
        ),
        if (_status != _Status.idle)
          Container(
            margin: const EdgeInsets.only(top: 4),
            decoration: BoxDecoration(
              color: AppColors.surface,
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(AppSizes.radiusSmall),
            ),
            clipBehavior: Clip.antiAlias,
            child: switch (_status) {
              _Status.loading => const Padding(
                padding: EdgeInsets.all(12),
                child: Center(
                  child: SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      semanticsLabel: '候補を取得中',
                    ),
                  ),
                ),
              ),
              _Status.failed => Padding(
                padding: const EdgeInsets.all(12),
                child: LoadErrorView(onRetry: () => _load(_query)),
              ),
              _ when _items.isEmpty => Padding(
                padding: const EdgeInsets.all(12),
                child: Semantics(
                  liveRegion: true,
                  child: const Text(
                    SuggestionField.emptyMessage,
                    style: TextStyle(color: AppColors.textMuted, fontSize: 14),
                  ),
                ),
              ),
              _ => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final (index, item) in _items.indexed)
                    _SuggestionTile(
                      label: widget.itemLabel(item),
                      detail: widget.itemDetail?.call(item),
                      showDivider: index > 0,
                      onTap: () => _select(item),
                    ),
                ],
              ),
            },
          ),
      ],
    );
  }
}

class _SuggestionTile extends StatelessWidget {
  const _SuggestionTile({
    required this.label,
    required this.detail,
    required this.showDivider,
    required this.onTap,
  });

  final String label;
  final String? detail;
  final bool showDivider;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final detail = this.detail;
    return Semantics(
      button: true,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: AppSizes.tapTarget),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          alignment: Alignment.centerLeft,
          decoration: BoxDecoration(
            border: showDivider
                ? const Border(top: BorderSide(color: AppColors.border))
                : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label),
              if (detail != null)
                Text(
                  detail,
                  style: const TextStyle(
                    color: AppColors.textMuted,
                    fontSize: 13,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
